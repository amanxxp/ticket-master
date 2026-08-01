import { createApiError } from "../utils/apiError.js";
import { readLiveHolds } from "../../../shared/availability.js";
import redis from "../config/redis.js";
import { eventExistsActive } from "../repositories/event.repository.js";
import { getAllTicketsForEvent } from "../repositories/ticket.repository.js";

// Effective status per ticket: Postgres and Redis merged into one answer.
//
// Booked beats held unconditionally — a ticket is only ever checked against the
// hold map when Postgres says 'available'. This is also what makes a stale hold
// harmless: confirmBooking (Booking Service) does not clear the Redis entry it
// claimed, and does not need to — by the time this runs, `status='booked'`
// already wins before the hold map is even consulted.
//
// Exactly 2 Redis round trips total (inside readLiveHolds), regardless of how
// many tickets the event has — the merge itself is an in-process Map lookup per
// ticket, not a Redis call per ticket.
export const getSeatMap = async (eventId, viewerUserId) => {
    if (!(await eventExistsActive(eventId))) {
        throw createApiError(`Event ${eventId} not found`, 404);
    }

    const tickets = await getAllTicketsForEvent(eventId);
    const holds = await readLiveHolds(redis, eventId);

    const seats = tickets.map((ticket) => {
        if (ticket.status === "booked") {
            return { ticketId: ticket.id, seat: ticket.seat, price: ticket.price, status: "booked" };
        }

        const hold = holds.get(ticket.id);
        if (hold) {
            return {
                ticketId: ticket.id,
                seat: ticket.seat,
                price: ticket.price,
                status: "held",
                // Only meaningful when the caller identified themselves; a
                // guest browsing the seat map gets `held` with no ownership claim.
                heldByMe: viewerUserId != null && hold.userId === viewerUserId,
                expiresAt: hold.expiresAt,
            };
        }

        return { ticketId: ticket.id, seat: ticket.seat, price: ticket.price, status: "available" };
    });

    return { eventId, seats };
};
