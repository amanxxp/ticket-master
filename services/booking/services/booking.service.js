import { createApiError } from "../utils/apiError.js";
import { withTransaction } from "../utils/transaction.js";
import { sumPrices } from "../utils/money.js";
import { publishAvailabilityChange } from "../utils/publishAvailability.js";
import {
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

export const confirmBooking = async ({ userId, eventId, ticketIds }) => {
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

            const totalAmount = sumPrices(booked.map((t) => t.price));

            // Week 1 has no payment step, so a confirm that reaches here is
            // terminal (invariant 4). Week 5 inserts a `pending` row, charges
            // Stripe, then promotes it.
            const booking = await insertBooking(client, {
                userId,
                eventId,
                status: "confirmed",
                totalAmount,
            });

            await insertBookingItems(client, booking.id, ticketIds);

            await insertOutboxEvent(client, {
                aggregateType: "booking",
                aggregateId: booking.id,
                payload: {
                    type: "booking.confirmed",
                    bookingId: booking.id,
                    eventId,
                    userId,
                    ticketIds,
                    totalAmount,
                },
            });

            return { ...booking, ticketIds };
        });

        // After commit, not inside the transaction callback above: a later step
        // in that callback could still throw and roll everything back, and
        // publishing before commit would announce a booking that never happened.
        await publishAvailabilityChange(eventId, "confirm", ticketIds);

        return result;
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
