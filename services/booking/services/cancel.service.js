import { createApiError } from "../utils/apiError.js";
import { withTransaction } from "../utils/transaction.js";
import { publishAvailabilityChange } from "../utils/publishAvailability.js";
import {
    lockBookingForCancel,
    getBookedTicketIds,
    releaseBookedTickets,
    markBookingStatus,
    insertOutboxEvent,
} from "../repositories/booking.repository.js";
import { notifyNextWaitlisted } from "../repositories/waitlist.repository.js";
import { findPaymentByBooking } from "../repositories/payment.repository.js";
import { refundBooking } from "./payment.service.js";

// How long a notified waitlist user has to act before the seat moves on. Short
// on purpose: every second of this window is a seat nobody can buy, and the
// whole point of releasing it was to sell it.
const CLAIM_WINDOW_SECONDS = Number(process.env.WAITLIST_CLAIM_WINDOW_SECONDS) || 600;

// Terminal states, and which one a cancel lands on:
//
//   pending   → cancelled   no money moved yet, nothing to give back
//   confirmed → refunded    money moved; Week 6 Day 1 makes the Stripe call
//
// Two distinct terminal states rather than one, because "we never charged you"
// and "we charged you and gave it back" are different facts about the same
// booking, and a reconciler has to be able to tell them apart without joining to
// payments. Until Week 6 wires the real refund, the refund is a stub and this
// still records 'refunded' — the state transition is the part being built here,
// the provider call is the part being deferred.
const terminalStateFor = (currentStatus) =>
    currentStatus === "confirmed" ? "refunded" : "cancelled";

export const cancelBooking = async ({ bookingId, userId, correlationId }) => {
    const result = await withTransaction(async (client) => {
        const booking = await lockBookingForCancel(client, bookingId);

        // 404 rather than 403 on someone else's booking, matching getBooking: a
        // 403 would confirm the id belongs to *somebody*, which leaks booking
        // existence to a caller with no right to know it.
        if (!booking || booking.userId !== userId) {
            throw createApiError(`Booking ${bookingId} not found`, 404);
        }

        // Idempotent in effect, explicit in reporting. The state change happens
        // exactly once — a second cancel releases nothing, notifies nobody, and
        // issues no second refund — and the caller is told plainly that it had
        // already happened rather than being handed a misleading 200 that looks
        // like it just did something.
        if (booking.status === "cancelled" || booking.status === "refunded") {
            throw createApiError(
                `Booking ${bookingId} is already ${booking.status}`,
                409
            );
        }

        const ticketIds = await getBookedTicketIds(client, bookingId);
        const released = await releaseBookedTickets(client, bookingId, ticketIds);

        const nextStatus = terminalStateFor(booking.status);
        const updated = await markBookingStatus(client, bookingId, nextStatus, [
            "pending",
            "confirmed",
        ]);
        if (!updated) {
            // Unreachable while the row lock above is held. Kept as an assertion
            // rather than an assumption: if a future change drops the lock, this
            // surfaces as a clean conflict instead of a half-cancelled booking.
            throw createApiError(`Booking ${bookingId} changed state concurrently`, 409);
        }

        // One notification per released ticket. Each call takes a different
        // waitlist row (FOR UPDATE SKIP LOCKED), so N released tickets notify N
        // distinct users — never the same user N times, never one user for N
        // seats.
        const notified = [];
        for (let i = 0; i < released.length; i++) {
            const entry = await notifyNextWaitlisted(client, booking.eventId, CLAIM_WINDOW_SECONDS);
            if (!entry) break;
            notified.push(entry);
        }

        // Inside the transaction, like every other outbox write: if the cancel
        // rolls back, the announcement of it must roll back too.
        await insertOutboxEvent(client, {
            aggregateType: "booking",
            aggregateId: bookingId,
            payload: {
                type: nextStatus === "refunded" ? "booking.refunded" : "booking.cancelled",
                bookingId,
                eventId: booking.eventId,
                userId,
                ticketIds: released,
                notifiedWaitlistUserIds: notified.map((n) => n.userId),
                correlationId,
            },
        });

        // The refund runs inside this transaction deliberately: if Stripe refuses,
        // everything above rolls back rather than leaving seats released for a
        // booking whose money never came back. That is the opposite ordering from
        // the charge path — and correct for the opposite reason. A charge must
        // commit its intent first because the risk is money moving with no record;
        // a refund's risk is a record with no money moving, so it belongs where a
        // failure can still undo the record.
        //
        // `null` means there was nothing to refund: a booking that never got past
        // 'pending', or one already refunded by a concurrent cancel.
        const payment = await findPaymentByBooking(client, bookingId);
        const refund = await refundBooking({ client, booking, payment });

        return { booking, released, notified, nextStatus, refund };
    });

    // After commit, never inside it — announcing a release that a later rollback
    // undoes would show seats as free that were never freed.
    await publishAvailabilityChange(
        result.booking.eventId,
        "seats.released",
        result.released.map(String),
        correlationId
    );

    return {
        bookingId,
        eventId: result.booking.eventId,
        status: result.nextStatus,
        releasedTicketIds: result.released.map(String),
        waitlistNotified: result.notified.length,
        refund: result.refund,
    };
};
