import { createApiError } from "../utils/apiError.js";
import { withTransaction } from "../utils/transaction.js";
import { sumPrices } from "../utils/money.js";
import {
    recordPaymentIntent,
    executeCharge,
    settlePayment,
    failPayment,
    assertPaymentMethod,
} from "./payment.service.js";
import { publishAvailabilityChange } from "../utils/publishAvailability.js";
import {
    getBookedTicketIds,
    releaseBookedTickets,
    markBookingStatus,
    lockTicketsForBooking,
    bookTickets,
    bookTicketsUnguarded,
    insertBooking,
    insertBookingItems,
    insertOutboxEvent,
    getEventForBooking,
    getBookingById,
} from "../repositories/booking.repository.js";

// Set only by the guard-removal acceptance test. Read per call rather than at
// import time so the test can flip it without a rebuild, and logged loudly
// because a production process must never come up in this mode unnoticed.
const guardDisabled = () => process.env.BOOKING_DISABLE_ROWCOUNT_GUARD === "true";

// Postgres raises 23505 on UNIQUE(ticket_id) when the backstop catches a
// double-book. That is a lost race, not a malformed request, so it maps to 409 —
// the same status the primary guard returns, which keeps the acceptance test's
// tally meaningful whichever guard actually fired.
const UNIQUE_VIOLATION = "23505";
const DEADLOCK_DETECTED = "40P01";

export const confirmBooking = async ({ userId, eventId, ticketIds, paymentMethodId, correlationId }) => {
    assertPaymentMethod(paymentMethodId);

    try {
        const result = await withTransaction(async (client) => {
            const event = await getEventForBooking(client, eventId);
            if (!event) {
                throw createApiError(`Event ${eventId} not found`, 404);
            }

            const bypass = guardDisabled();

            // Skipped entirely when the guard is disabled: the lock would
            // serialize the racers and mask the backstop under test.
            if (!bypass) {
                const locked = await lockTicketsForBooking(client, eventId, ticketIds);

                if (locked.length !== ticketIds.length) {
                    const found = new Set(locked.map((t) => t.id));
                    const missing = ticketIds.filter((id) => !found.has(id));
                    throw createApiError(
                        `Ticket(s) ${missing.join(", ")} not found for event ${eventId}`,
                        404
                    );
                }

                const taken = locked.filter((t) => t.status !== "available");
                if (taken.length > 0) {
                    // All-or-nothing: one unavailable seat fails the whole
                    // request, and the transaction rolls back, so the caller
                    // never leaves a partially-booked set behind.
                    throw createApiError(
                        `Ticket(s) ${taken.map((t) => t.id).join(", ")} are no longer available`,
                        409
                    );
                }
            }

            const booked = bypass
                ? await bookTicketsUnguarded(client, eventId, ticketIds)
                : await bookTickets(client, eventId, ticketIds);

            // The primary guard. Even holding the row locks, the count is
            // re-checked: it is the single assertion that every requested seat
            // was still 'available' at the moment of the write.
            if (!bypass && booked.length !== ticketIds.length) {
                throw createApiError(
                    `Ticket(s) already booked by a concurrent request`,
                    409
                );
            }

            // Server-derived, from the prices the UPDATE returned — never from
            // the request body (invariant 7). A client that sends `amount` or
            // `price` has already been rejected by the validator; even if it had
            // not been, nothing here reads them.
            const totalAmount = sumPrices(booked.map((t) => t.price));

            // 'pending', not 'confirmed'. The money has not moved yet, and a
            // booking that claims to be confirmed before it is paid for is the
            // free-tickets bug. It is promoted after the charge answers.
            const booking = await insertBooking(client, {
                userId,
                eventId,
                status: "pending",
                totalAmount,
            });

            await insertBookingItems(client, booking.id, ticketIds);

            // Committed with the booking, BEFORE Stripe is contacted. A crash
            // between this commit and the charge leaves a `pending` payment the
            // reconciler resolves against Stripe by idempotency key.
            const { payment } = await recordPaymentIntent(client, {
                bookingId: booking.id,
                totalAmount,
            });

            return { ...booking, ticketIds, payment };
        });

        // ---- charge, outside any transaction -----------------------------
        // No row locks are held across this network call. The tickets are already
        // 'booked' under a 'pending' booking, so nobody else can take them while
        // the provider thinks.
        const charge = await executeCharge({
            booking: { id: result.id, eventId, userId },
            totalAmount: result.totalAmount,
            paymentMethodId,
        });

        if (!charge.ok) {
            // Compensating transaction: give the seats back and put the booking in
            // a terminal state. Without this a declined card would leave seats
            // locked to a booking that will never be paid — the seats would only
            // reappear when the reconciler noticed, minutes later.
            await withTransaction(async (client) => {
                await failPayment(client, result.payment.id, charge.intent?.id);
                const ticketIdsToRelease = await getBookedTicketIds(client, result.id);
                await releaseBookedTickets(client, result.id, ticketIdsToRelease);
                await markBookingStatus(client, result.id, "cancelled", ["pending"]);
            });
            await publishAvailabilityChange(eventId, "seats.released", ticketIds, correlationId);
            throw createApiError(
                `Payment failed (${charge.status}); seats released`,
                402
            );
        }

        // Failure-injection hook (Week 6 Day 3), same pattern and same warning as
        // BOOKING_DISABLE_ROWCOUNT_GUARD: read per call so a test can flip it
        // without a restart, and it must never be set in a real deployment.
        //
        // This is the single most dangerous moment in the whole system — money has
        // moved and nothing durable records that it succeeded. The point of being
        // able to stop exactly here is to prove the reconciler recovers it.
        if (process.env.BOOKING_CRASH_AFTER_CHARGE === "true") {
            console.error(
                `[${correlationId}] INJECTED CRASH after charge ${charge.intent.id}, ` +
                `booking ${result.id} left pending`
            );
            process.exit(137);
        }

        // ---- settle -------------------------------------------------------
        await settlePayment(result.payment.id, charge.intent.id);

        const confirmed = await withTransaction(async (client) => {
            const promoted = await markBookingStatus(client, result.id, "confirmed", ["pending"]);

            // The outbox row is written here, not in the first transaction: a
            // `booking.confirmed` event must not exist for a booking whose charge
            // later declined. If the webhook promoted it first, `promoted` is null
            // and this is a no-op — the event was already emitted by that path.
            if (promoted) {
                await insertOutboxEvent(client, {
                    aggregateType: "booking",
                    aggregateId: result.id,
                    payload: {
                        type: "booking.confirmed",
                        bookingId: result.id,
                        eventId,
                        userId,
                        ticketIds,
                        totalAmount: result.totalAmount,
                        providerRef: charge.intent.id,
                        correlationId,
                    },
                });
            }
            return promoted;
        });

        // After commit, not inside a transaction callback: a later step could
        // still throw and roll everything back, and publishing before commit
        // would announce a booking that never happened.
        await publishAvailabilityChange(eventId, "confirm", ticketIds, correlationId);

        return {
            ...result,
            status: confirmed?.status ?? "confirmed",
            payment: undefined,
            providerRef: charge.intent.id,
        };
    } catch (error) {
        if (error.isApiError) throw error;

        if (error.code === UNIQUE_VIOLATION) {
            throw createApiError("Ticket(s) already booked by a concurrent request", 409);
        }
        // Should be unreachable given ORDER BY id in the lock step. Mapped
        // rather than swallowed so a real deadlock shows up as a retryable 409
        // instead of a 500 that hides a lock-ordering regression.
        if (error.code === DEADLOCK_DETECTED) {
            throw createApiError("Concurrent booking conflict, please retry", 409);
        }

        console.error("Error confirming booking", error);
        throw error;
    }
};

// 404, not 403, on a mismatch: a 403 would confirm the id belongs to *someone*,
// leaking booking existence to a caller who has no right to know it. Role-based
// override (organizer/admin viewing any booking) is Week 4 authz — not wired in yet.
export const getBooking = async (bookingId, userId) => {
    const booking = await getBookingById(bookingId);
    if (!booking || booking.userId !== userId) {
        throw createApiError(`Booking ${bookingId} not found`, 404);
    }
    return booking;
};
