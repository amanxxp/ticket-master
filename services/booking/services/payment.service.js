import { stripe } from "../config/stripe.js";
import { createApiError } from "../utils/apiError.js";
import { withTransaction } from "../utils/transaction.js";
import { toCents } from "../utils/money.js";
import {
    insertPendingPayment,
    findPaymentByIdempotencyKey,
    markPaymentStatus,
    UNIQUE_VIOLATION,
} from "../repositories/payment.repository.js";

const CURRENCY = process.env.STRIPE_CURRENCY || "inr";

// Derived from the booking id, not generated per attempt. This is what makes a
// retry safe: the same booking retried after a timeout, a crash, or a
// double-clicked button reuses the same key, so Stripe returns the original
// intent instead of charging again. A random key per attempt would satisfy the
// API and still double-charge.
export const idempotencyKeyFor = (bookingId) => `booking:${bookingId}`;

// Three separate steps, in three separate transactions, because the ordering is
// the correctness property:
//
//   1. recordPaymentIntent   — COMMITTED before the provider is contacted
//   2. executeCharge         — no transaction at all
//   3. settlePayment         — a new transaction after the provider answers
//
// The obvious shape — one transaction wrapping all three — is wrong in a way that
// only shows up on a crash: if the process dies after Stripe succeeds but before
// COMMIT, the whole transaction rolls back INCLUDING the payments row, and the
// money that moved has nothing in the database pointing at it. Nothing to sweep,
// nothing to reconcile, no way to find it except by reading Stripe's dashboard.
// Committing step 1 first is what guarantees a crash anywhere after it leaves a
// `pending` row the reconciler can resolve (invariant 4).
//
// The cost of splitting: between 1 and 3 the tickets are 'booked' under a
// 'pending' booking. That is a real intermediate state, and it is why the
// reconciler exists rather than being optional.

// Step 1. Runs inside the CALLER's transaction — the same one that books the
// tickets — so a booking can never exist without its payment intent, or vice
// versa. `idempotency_key` is UNIQUE, which makes this insert double as the
// concurrency guard: two simultaneous confirms of one booking cannot both create
// an intent; the loser gets 23505 and reads the winner's row.
export const recordPaymentIntent = async (client, { bookingId, totalAmount }) => {
    const idempotencyKey = idempotencyKeyFor(bookingId);
    try {
        return {
            payment: await insertPendingPayment(client, {
                bookingId,
                amount: totalAmount,
                idempotencyKey,
            }),
            preexisting: false,
        };
    } catch (error) {
        if (error.code === UNIQUE_VIOLATION) {
            return { payment: await findPaymentByIdempotencyKey(idempotencyKey), preexisting: true };
        }
        throw error;
    }
};

// Step 2. Deliberately takes no client and opens no transaction — a network call
// of unbounded duration must not be holding Postgres row locks on the tickets
// this booking just claimed.
//
// The amount NEVER comes from the request. It arrives here already summed
// server-side from `tickets.price`, and `toCents` parses the NUMERIC string pg
// returns rather than a float, so ₹5000.00 becomes exactly 500000.
export const executeCharge = async ({ booking, totalAmount, paymentMethodId }) => {
    const idempotencyKey = idempotencyKeyFor(booking.id);
    const amountMinor = toCents(totalAmount);

    try {
        const intent = await stripe.paymentIntents.create(
            {
                amount: amountMinor,
                currency: CURRENCY,
                payment_method: paymentMethodId,
                confirm: true,
                // Off-session so fake and real behave alike without a redirect leg.
                // A real 3DS integration would surface `requires_action` here and
                // need a client-side step, which this project does not build.
                off_session: true,
                metadata: {
                    bookingId: String(booking.id),
                    eventId: String(booking.eventId),
                    userId: String(booking.userId),
                },
            },
            { idempotencyKey }
        );
        return { ok: intent.status === "succeeded", intent, status: intent.status, amountMinor };
    } catch (error) {
        // A decline is an answer, not a failure to get one. Returned rather than
        // thrown so the caller runs its compensating transaction (release the
        // seats, mark the payment failed) on the same code path it uses for any
        // other unsuccessful outcome.
        return { ok: false, error, status: error.code ?? "provider_error", amountMinor };
    }
};

// Step 3. Its own transaction. Guarded on `['pending']` so a webhook that already
// settled this payment makes the synchronous path a no-op instead of a second
// write — whichever of the two arrives first wins, and both leave the same state.
export const settlePayment = async (paymentId, providerRef) =>
    withTransaction((client) =>
        markPaymentStatus(client, paymentId, "succeeded", ["pending"], providerRef)
    );

export const failPayment = async (client, paymentId, providerRef) =>
    markPaymentStatus(client, paymentId, "failed", ["pending"], providerRef ?? null);

// Refund keyed on the booking, so a retried cancel cannot refund twice. Returns
// null when there is nothing to give back — a booking that never got past
// 'pending' — which the cancel path reports as `refund: null` rather than
// inventing a zero-value refund.
export const refundBooking = async ({ client, booking, payment }) => {
    if (!payment || payment.status !== "succeeded" || !payment.providerRef) {
        return null;
    }

    const refund = await stripe.refunds.create(
        { payment_intent: payment.providerRef },
        { idempotencyKey: `refund:${booking.id}` }
    );

    // 'refunded' is reachable only from 'succeeded'. A concurrent second cancel
    // finds the row already 'refunded', matches no allowed source state, and
    // issues no second provider call — the guard is the transition itself, not a
    // flag the caller remembered to check.
    const moved = await markPaymentStatus(client, payment.id, "refunded", ["succeeded"], payment.providerRef);
    if (!moved) return null;

    return { refundId: refund.id, status: refund.status, amount: payment.amount };
};

export const assertPaymentMethod = (paymentMethodId) => {
    if (typeof paymentMethodId !== "string" || paymentMethodId.length === 0 || paymentMethodId.length > 255) {
        throw createApiError("paymentMethodId is required", 422);
    }
    return paymentMethodId;
};
