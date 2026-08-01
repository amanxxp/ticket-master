import { createApiError } from "../utils/apiError.js";
import { readLiveHolds } from "../../../shared/availability.js";
import redis from "../config/redis.js";
import { eventExistsActive } from "../repositories/event.repository.js";
import { getAllTicketsForEvent, getTicketsByIds } from "../repositories/ticket.repository.js";

// Effective status for one ticket: Postgres and a live-holds map merged into one
// answer. Exported and reused, not inlined, because the Day 3 stream's delta
// push has to render the exact same rule the seat map snapshot does — two
// implementations of "booked beats held" is how the two disagree.
//
// Booked beats held unconditionally — a ticket is only ever checked against the
// hold map when Postgres says 'available'. This is also what makes a stale hold
// harmless: confirmBooking (Booking Service) does not clear the Redis entry it
// claimed, and does not need to — by the time this runs, `status='booked'`
// already wins before the hold map is even consulted.
export const toSeatStatus = (ticket, holds, viewerUserId) => {
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
            // Only meaningful when the caller identified themselves; a guest
            // browsing the seat map gets `held` with no ownership claim.
            heldByMe: viewerUserId != null && hold.userId === viewerUserId,
            expiresAt: hold.expiresAt,
        };
    }

    return { ticketId: ticket.id, seat: ticket.seat, price: ticket.price, status: "available" };
};

// The full snapshot: every ticket, effective status. Used by GET /seatmap
// directly, and by the stream's initial push on connect (and on reconnect) —
// same function, so "reconnect gets a correct snapshot from the same code the
// stream uses" is true by construction rather than by two paths matching.
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
    const seats = tickets.map((ticket) => toSeatStatus(ticket, holds, viewerUserId));
    return { eventId, seats };
};

// The delta path: same merge, scoped to the tickets one pub/sub message named
// instead of the whole event. `holds` is still a full-event read (readLiveHolds
// takes no ticket filter) — cheap, since it costs the same 2 round trips as the
// snapshot and scales with live-hold count, not ticket count.
//
// Returns raw tickets + the holds map rather than pre-rendered seats: heldByMe
// is per-viewer, and one incoming message fans out to N differently-viewed
// clients, so the per-viewer render has to happen once per connection, not once
// per message.
export const getTicketDeltas = async (eventId, ticketIds) => {
    const [tickets, holds] = await Promise.all([
        getTicketsByIds(eventId, ticketIds),
        readLiveHolds(redis, eventId),
    ]);
    return { tickets, holds };
};
