import { constructWebhookEvent } from "../config/stripe.js";
import { createApiError } from "../utils/apiError.js";
import { withTransaction } from "../utils/transaction.js";
import { publishAvailabilityChange } from "../utils/publishAvailability.js";
import {
    recordWebhookEvent,
    WEBHOOK_ALREADY_SEEN,
} from "../repositories/webhook.repository.js";
import { findPaymentByIdempotencyKey, markPaymentStatus } from "../repositories/payment.repository.js";
import {
    lockBookingForCancel,
    getBookedTicketIds,
    releaseBookedTickets,
    markBookingStatus,
    insertOutboxEvent,
} from "../repositories/booking.repository.js";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// The one endpoint in this system with no gateway auth and no rate limit — Stripe
// carries no JWT, and throttling it would drop payment confirmations Stripe would
// then stop retrying. Its entire security boundary is this function.
//
// Verification uses the real Stripe library even in fake mode (see
// config/stripe.js): an unverified webhook endpoint is a free-tickets endpoint,
// and a hand-rolled HMAC compare is the last place to be clever.
export const verifyAndParse = (rawBody, signatureHeader) => {
    if (!signatureHeader) {
        throw createApiError("Missing stripe-signature header", 400);
    }
    if (!WEBHOOK_SECRET) {
        // 500, not 400: a missing secret is our misconfiguration, not a bad
        // request, and answering 400 would make Stripe give up retrying events
        // that are perfectly valid.
        throw createApiError("Webhook secret not configured", 500);
    }

    try {
        // `rawBody` must be the exact bytes Stripe signed. Anything that has been
        // through JSON.parse and re-stringified will not verify — key order and
        // whitespace both matter. This is why the route mounts express.raw ahead
        // of the global express.json (see app.js).
        return constructWebhookEvent(rawBody, signatureHeader, WEBHOOK_SECRET);
    } catch (error) {
        throw createApiError(`Invalid webhook signature: ${error.message}`, 400);
    }
};

// Maps a provider event to the payment it concerns. Stripe's own idempotency key
// is echoed back on the intent's `metadata`/request, but the reliable link here is
// the bookingId we put in metadata at charge time.
const bookingIdFromEvent = (event) => {
    const object = event.data?.object ?? {};
    const fromMetadata = object.metadata?.bookingId;
    if (fromMetadata) return String(fromMetadata);
    return null;
};

const handleSucceeded = async (client, bookingId, providerRef, correlationId) => {
    const payment = await findPaymentByIdempotencyKey(`booking:${bookingId}`);
    if (!payment) return { action: "no_payment_row" };

    // Guarded on ['pending'] only. If the synchronous confirm path already settled
    // this, the update matches nothing and the webhook is a no-op — whichever
    // arrives first wins and both leave identical state. This is also what makes a
    // late `succeeded` arriving AFTER a refund harmless: 'refunded' is not in the
    // allowed source set, so nothing moves.
    const settled = await markPaymentStatus(client, payment.id, "succeeded", ["pending"], providerRef);
    if (!settled) return { action: "already_terminal", status: payment.status };

    const promoted = await markBookingStatus(client, bookingId, "confirmed", ["pending"]);
    if (promoted) {
        await insertOutboxEvent(client, {
            aggregateType: "booking",
            aggregateId: bookingId,
            payload: { type: "booking.confirmed", bookingId, viaWebhook: true, correlationId },
        });
    }
    return { action: "settled", promoted: Boolean(promoted) };
};

const handleFailed = async (client, bookingId, providerRef, correlationId) => {
    const payment = await findPaymentByIdempotencyKey(`booking:${bookingId}`);
    if (!payment) return { action: "no_payment_row" };

    const failed = await markPaymentStatus(client, payment.id, "failed", ["pending"], providerRef);
    if (!failed) return { action: "already_terminal", status: payment.status };

    // Same compensating transaction the synchronous decline path runs: seats must
    // not stay locked to a booking that will never be paid. Reached when the
    // charge was still 'pending' — e.g. the process died mid-confirm and Stripe's
    // failure notice is the first thing to learn the outcome.
    const booking = await lockBookingForCancel(client, bookingId);
    if (!booking || booking.status !== "pending") {
        return { action: "failed_payment_only", bookingStatus: booking?.status };
    }

    const ticketIds = await getBookedTicketIds(client, bookingId);
    const released = await releaseBookedTickets(client, bookingId, ticketIds);
    await markBookingStatus(client, bookingId, "cancelled", ["pending"]);
    await insertOutboxEvent(client, {
        aggregateType: "booking",
        aggregateId: bookingId,
        payload: { type: "booking.cancelled", bookingId, reason: "payment_failed", viaWebhook: true, correlationId },
    });

    return { action: "failed_and_released", eventId: booking.eventId, released };
};

const handleRefunded = async (client, bookingId, providerRef, correlationId) => {
    const payment = await findPaymentByIdempotencyKey(`booking:${bookingId}`);
    if (!payment) return { action: "no_payment_row" };

    // Only from 'succeeded'. A refund notice for a payment already marked refunded
    // by our own cancel path changes nothing.
    const refunded = await markPaymentStatus(client, payment.id, "refunded", ["succeeded"], providerRef);
    if (!refunded) return { action: "already_terminal", status: payment.status };

    const booking = await lockBookingForCancel(client, bookingId);
    if (!booking || !["pending", "confirmed"].includes(booking.status)) {
        return { action: "refund_recorded_only", bookingStatus: booking?.status };
    }

    // A refund issued directly in the Stripe dashboard, with no cancel on our
    // side, lands here — the seats have to come back or they are unsellable
    // forever with nobody having paid for them.
    const ticketIds = await getBookedTicketIds(client, bookingId);
    const released = await releaseBookedTickets(client, bookingId, ticketIds);
    await markBookingStatus(client, bookingId, "refunded", ["pending", "confirmed"]);
    await insertOutboxEvent(client, {
        aggregateType: "booking",
        aggregateId: bookingId,
        payload: { type: "booking.refunded", bookingId, viaWebhook: true, correlationId },
    });

    return { action: "refunded_and_released", eventId: booking.eventId, released };
};

export const processEvent = async (event, correlationId) => {
    const bookingId = bookingIdFromEvent(event);
    const providerRef = event.data?.object?.id ?? null;

    const outcome = await withTransaction(async (client) => {
        // Claimed FIRST, inside the same transaction as the state change. A
        // duplicate delivery raises 23505 here and the whole transaction aborts
        // before touching anything — that is what makes "same event twice → one
        // state change" a database guarantee rather than a handler convention.
        //
        // Recording it after processing instead would leave a window where a
        // retry arriving mid-processing runs the handler a second time.
        try {
            await recordWebhookEvent(client, {
                provider: "stripe",
                eventId: event.id,
                type: event.type,
            });
        } catch (error) {
            if (error.code === WEBHOOK_ALREADY_SEEN) {
                return { duplicate: true };
            }
            throw error;
        }

        if (!bookingId) {
            // Acked, not errored. An event we cannot route (a Stripe event type we
            // never subscribed to, or one with no bookingId metadata) is not a bad
            // request — returning 400 would make Stripe retry it forever.
            return { unrouted: true, type: event.type };
        }

        switch (event.type) {
            case "payment_intent.succeeded":
                return handleSucceeded(client, bookingId, providerRef, correlationId);
            case "payment_intent.payment_failed":
                return handleFailed(client, bookingId, providerRef, correlationId);
            case "charge.refunded":
            case "refund.created":
                return handleRefunded(client, bookingId, providerRef, correlationId);
            default:
                return { ignored: true, type: event.type };
        }
    });

    // Published after commit, like every other availability change.
    if (outcome.released?.length) {
        await publishAvailabilityChange(
            outcome.eventId,
            "seats.released",
            outcome.released.map(String),
            correlationId
        );
    }

    return outcome;
};
