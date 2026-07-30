import { createApiError } from "../utils/apiError.js";
import { rethrowPgError } from "../utils/helper.js";
import { withTransaction } from "../utils/transaction.js";
import { expandSeatMap } from "../utils/seatMap.js";
import { insertOutboxEvent } from "../repositories/outbox.repository.js";
import { lockEvent } from "../repositories/event.repository.js";
import {
    insertTickets,
    getTicketsByEvent,
    getTicketById,
    lockTicket,
    updateTicketPrice,
    deleteTicket,
    countBookingItemsForTicket,
    getSeatMapForEvent,
} from "../repositories/ticket.repository.js";

const emit = (client, type, ticket) =>
    insertOutboxEvent(client, {
        aggregateType: "ticket",
        aggregateId: ticket.id,
        payload: { type, ticket },
    });

// Locking the event row first does two things: it 404s a deleted event before
// any inventory is written, and it serializes against the event delete guard, so
// tickets cannot appear under an event that is concurrently being deleted.
const mint = async (eventId, buildTickets) => {
    try {
        return await withTransaction(async (client) => {
            if (!(await lockEvent(client, eventId))) {
                throw createApiError(`Event ${eventId} not found`, 404);
            }

            const tickets = await buildTickets(client);
            const created = await insertTickets(client, eventId, tickets);

            // One outbox row per ticket would mean 50k rows for a large mint, so
            // the batch is announced as a single event carrying the ids.
            if (created.length > 0) {
                await insertOutboxEvent(client, {
                    aggregateType: "event",
                    aggregateId: eventId,
                    payload: {
                        type: "tickets.created",
                        eventId,
                        ticketIds: created.map((t) => t.id),
                    },
                });
            }

            return {
                requested: tickets.length,
                created: created.length,
                // Re-running a mint is expected (retries, adding a section later),
                // so pre-existing seats are reported rather than treated as errors.
                skippedExisting: tickets.length - created.length,
                tickets: created,
            };
        });
    } catch (error) {
        if (error.isApiError) throw error;
        rethrowPgError(error, "create", "tickets");
    }
};

export const createTickets = async (eventId, tickets) =>
    mint(eventId, async () => tickets);

export const generateTickets = async (eventId, pricingInput) =>
    mint(eventId, async (client) => {
        const seatMap = await getSeatMapForEvent(client, eventId);
        if (!seatMap) {
            throw createApiError(`Event ${eventId} not found`, 404);
        }
        return expandSeatMap(seatMap, pricingInput);
    });

export const getAllTickets = async (filters) => {
    return await getTicketsByEvent(filters);
};

export const getTicket = async (eventId, ticketId) => {
    const ticket = await getTicketById(eventId, ticketId);
    if (!ticket) {
        throw createApiError(`Ticket ${ticketId} not found for event ${eventId}`, 404);
    }
    return ticket;
};

export const editTicketPrice = async (eventId, ticketId, price) => {
    try {
        return await withTransaction(async (client) => {
            const existing = await lockTicket(client, eventId, ticketId);
            if (!existing) {
                throw createApiError(`Ticket ${ticketId} not found for event ${eventId}`, 404);
            }
            // total_amount on a booking is computed from tickets.price at confirm
            // time, so repricing a sold seat would disagree with what was charged.
            if (existing.status === "booked") {
                throw createApiError(
                    `Cannot reprice ticket ${ticketId}: already booked`,
                    409
                );
            }

            const ticket = await updateTicketPrice(client, eventId, ticketId, price);
            await emit(client, "ticket.updated", ticket);
            return ticket;
        });
    } catch (error) {
        if (error.isApiError) throw error;
        rethrowPgError(error, "update", "ticket");
    }
};

export const removeTicket = async (eventId, ticketId) => {
    try {
        return await withTransaction(async (client) => {
            const existing = await lockTicket(client, eventId, ticketId);
            if (!existing) {
                throw createApiError(`Ticket ${ticketId} not found for event ${eventId}`, 404);
            }
            if (existing.status === "booked") {
                throw createApiError(`Cannot delete ticket ${ticketId}: already booked`, 409);
            }
            // Covers the window where a booking_items row exists while the ticket
            // still reads 'available'. The FK would raise 23503 anyway, but that
            // surfaces as an opaque 400 instead of naming the real reason.
            const items = await countBookingItemsForTicket(client, ticketId);
            if (items > 0) {
                throw createApiError(
                    `Cannot delete ticket ${ticketId}: referenced by a booking`,
                    409
                );
            }

            const deleted = await deleteTicket(client, eventId, ticketId);
            if (!deleted) {
                throw createApiError(`Ticket ${ticketId} not found for event ${eventId}`, 404);
            }
            await emit(client, "ticket.deleted", { id: deleted.id });
            return { id: deleted.id };
        });
    } catch (error) {
        if (error.isApiError) throw error;
        rethrowPgError(error, "delete", "ticket");
    }
};
