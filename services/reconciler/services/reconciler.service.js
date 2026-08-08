import { stripe } from "../config/stripe.js";
import redis from "../config/redis.js";
import { withTransaction } from "../utils/transaction.js";
import {
    claimStalePendingPayments,
    markPaymentStatus,
    lockBooking,
    getBookedTicketIds,
    releaseBookedTickets,
    markBookingStatus,
    insertOutboxEvent,
    expireLapsedClaims,
    listEventsWithHolds,
    listBookedTicketIds,
} from "../repositories/reconciler.repository.js";
import { holdSeatsKey, holdOwnerKey, holdUserKey } from "../../../shared/availability.js";

import { numberFromEnv } from "../utils/env.js";

// numberFromEnv, not `Number(x) || 120`: zero is a legitimate value here (sweep
// everything immediately, which the failure drill relies on) and `||` would treat
// it as unset. See utils/env.js.
const PENDING_AFTER_SECONDS = numberFromEnv("RECONCILE_PENDING_AFTER_SECONDS", 120);

// Every counter this worker emits. Exported as a shape rather than logged ad hoc
// so a scrape endpoint or a test can assert on it — `driftFound` in particular is
// a bug signal, not background noise: a healthy system reports zero, and a
// non-zero reading means some path is leaving state behind.
export const emptyMetrics = () => ({
    pendingSwept: 0,
    pendingSettled: 0,
    pendingFailed: 0,
    pendingUnknown: 0,
    claimsExpired: 0,
    driftFound: 0,
    driftCleared: 0,
});

// Answers "did the provider actually charge this?" for a payment we lost track of.
//
// Two paths, because a crash can land either side of recording the reference:
//   · provider_ref known → retrieve it directly
//   · provider_ref NULL  → the charge may still have happened; the only way to
//     know is to ask by the metadata attached at charge time. This is the case
//     that makes the whole reconciler necessary, and the case that would be
//     unanswerable if the payments row were written AFTER the provider call.
const findProviderIntent = async (payment) => {
    if (payment.providerRef) {
        try {
            return await stripe.paymentIntents.retrieve(payment.providerRef);
        } catch (error) {
            if (error.code === "resource_missing") return null;
            throw error;
        }
    }

    const found = await stripe.paymentIntents.search({
        query: `metadata['bookingId']:'${payment.bookingId}'`,
    });
    return found.data?.[0] ?? null;
};

// Drives every stale 'pending' payment to a terminal state. Never leaves one
// pending (invariant 4) — including the "provider says nothing happened" case,
// which becomes 'failed' plus a seat release rather than being left for the next
// sweep to look at again forever.
export const sweepPendingPayments = async (metrics) => {
    const claimed = await withTransaction((client) =>
        claimStalePendingPayments(client, PENDING_AFTER_SECONDS)
    );
    metrics.pendingSwept += claimed.length;

    for (const payment of claimed) {
        const intent = await findProviderIntent(payment);

        await withTransaction(async (client) => {
            if (intent?.status === "succeeded") {
                // Money moved. The booking must be promoted, not released — this is
                // the crash-after-charge case, and releasing here would sell a seat
                // the customer already paid for to someone else.
                const settled = await markPaymentStatus(client, payment.id, "succeeded", ["pending"], intent.id);
                if (settled) {
                    const promoted = await markBookingStatus(client, payment.bookingId, "confirmed", ["pending"]);
                    if (promoted) {
                        await insertOutboxEvent(client, {
                            aggregateType: "booking",
                            aggregateId: payment.bookingId,
                            payload: { type: "booking.confirmed", bookingId: payment.bookingId, viaReconciler: true },
                        });
                    }
                    metrics.pendingSettled += 1;
                }
                return;
            }

            // No successful charge exists. Fail the payment and give the seats back
            // — they have been locked to an unpaid booking since the crash.
            const failed = await markPaymentStatus(client, payment.id, "failed", ["pending"], intent?.id ?? null);
            if (!failed) return;

            const booking = await lockBooking(client, payment.bookingId);
            if (booking?.status === "pending") {
                const ticketIds = await getBookedTicketIds(client, payment.bookingId);
                await releaseBookedTickets(client, payment.bookingId, ticketIds);
                await markBookingStatus(client, payment.bookingId, "cancelled", ["pending"]);
                await insertOutboxEvent(client, {
                    aggregateType: "booking",
                    aggregateId: payment.bookingId,
                    payload: {
                        type: "booking.cancelled",
                        bookingId: payment.bookingId,
                        reason: intent ? `provider_status:${intent.status}` : "no_provider_charge",
                        viaReconciler: true,
                    },
                });
            }
            if (intent) metrics.pendingFailed += 1;
            else metrics.pendingUnknown += 1;
        });
    }
};

// Waitlist claim windows that ran out. The entry goes to 'expired', never back to
// 'waiting' — re-queueing someone who already had their turn would starve
// everyone behind them on every release.
export const sweepExpiredClaims = async (metrics) => {
    const expired = await withTransaction((client) => expireLapsedClaims(client));
    metrics.claimsExpired += expired.length;
    return expired;
};

// Redis-vs-Postgres drift. Two directions, only one of which is a real problem:
//
//   · Held in Redis AND booked in Postgres → the hold outlived its own purchase.
//     Harmless to a reader (booked outranks held in the seat map) but it wastes the
//     per-user cap and, more importantly, means some path failed to clean up.
//     Cleared, and counted.
//
//   · Held in Redis, available in Postgres → normal. That is what a hold IS.
//     Not drift, and deliberately not counted.
//
// The cleanup is safe because Postgres is the arbiter: a ticket that is 'booked'
// there cannot be reserved by anyone regardless of what Redis says, so removing
// the stale hold key cannot hand the seat to a second buyer.
export const detectAndClearDrift = async (metrics) => {
    const eventIds = await listEventsWithHolds(redis);

    for (const eventId of eventIds) {
        const now = Date.now();
        const heldTicketIds = await redis.zRangeByScore(holdSeatsKey(eventId), now, "+inf");
        if (heldTicketIds.length === 0) continue;

        const bookedIds = new Set(await listBookedTicketIds(eventId, heldTicketIds));
        const stale = heldTicketIds.filter((id) => bookedIds.has(id));
        if (stale.length === 0) continue;

        metrics.driftFound += stale.length;

        const owners = await redis.hmGet(holdOwnerKey(eventId), stale);
        const multi = redis.multi();
        multi.zRem(holdSeatsKey(eventId), stale);
        multi.hDel(holdOwnerKey(eventId), stale);
        // The per-user index has to be cleaned too, or the cap keeps counting a
        // hold that no longer exists and the user is locked out of buying more.
        stale.forEach((ticketId, i) => {
            const userId = owners[i];
            if (userId) multi.zRem(holdUserKey(eventId, userId), ticketId);
        });
        await multi.exec();

        metrics.driftCleared += stale.length;
        console.warn(
            `reconciler: cleared ${stale.length} stale hold(s) on event ${eventId} — ` +
            `tickets ${stale.join(",")} were booked in Postgres but still held in Redis`
        );
    }
};

export const runOnce = async () => {
    const metrics = emptyMetrics();
    await sweepPendingPayments(metrics);
    await sweepExpiredClaims(metrics);
    await detectAndClearDrift(metrics);

    // Always emitted, including the all-zero case: "the sweep ran and found
    // nothing" and "the sweep did not run" have to be distinguishable from
    // outside, and silence cannot express the difference.
    console.log(`reconciler: ${JSON.stringify(metrics)}`);
    return metrics;
};
