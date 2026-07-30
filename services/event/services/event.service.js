import { createApiError } from "../utils/apiError.js";
import { rethrowPgError } from "../utils/helper.js";
import { withTransaction } from "../utils/transaction.js";
import { insertOutboxEvent } from "../repositories/outbox.repository.js";
import {
    insertEvent,
    getEvents,
    getEventById,
    updateEvent,
    softDeleteEvent,
    lockEvent,
    venueExistsActive,
    performerExists,
    countBookedTickets,
    countLiveBookings,
} from "../repositories/event.repository.js";

const emit = (client, type, event) =>
    insertOutboxEvent(client, {
        aggregateType: "event",
        aggregateId: event.id,
        payload: { type, event },
    });

export const createEvent = async (input) => {
    try {
        return await withTransaction(async (client) => {
            // The FK alone is not enough: it is satisfied by a soft-deleted venue,
            // which would put the event at a venue that no longer serves.
            if (!(await venueExistsActive(client, input.venueId))) {
                throw createApiError(`Venue ${input.venueId} not found or deleted`, 400);
            }
            if (!(await performerExists(client, input.performerId))) {
                throw createApiError(`Performer ${input.performerId} not found`, 400);
            }

            const event = await insertEvent(client, input);
            await emit(client, "event.created", event);
            return event;
        });
    } catch (error) {
        if (error.isApiError) throw error;
        rethrowPgError(error, "create", "event");
    }
};

export const getAllEvents = async (filters) => {
    return await getEvents(filters);
};

export const getEvent = async (id) => {
    const event = await getEventById(id);
    if (!event) {
        throw createApiError(`Event ${id} not found`, 404);
    }
    return event;
};

export const editEvent = async (id, changes) => {
    try {
        return await withTransaction(async (client) => {
            // FOR UPDATE before the guards: without the lock, a booking committed
            // between the ticket count and the update would slip past the check.
            if (!(await lockEvent(client, id))) {
                throw createApiError(`Event ${id} not found`, 404);
            }

            if (changes.venueId !== undefined) {
                if (!(await venueExistsActive(client, changes.venueId))) {
                    throw createApiError(`Venue ${changes.venueId} not found or deleted`, 400);
                }
                // Ticket seats were minted against the old venue's seat_map; the new
                // venue may not define those sections at all. Remapping is not safe
                // to guess, so the move is refused instead.
                const sold = await countBookedTickets(client, id);
                if (sold > 0) {
                    throw createApiError(
                        `Cannot change venue: ${sold} ticket(s) already sold against the current seat map`,
                        409
                    );
                }
            }

            if (changes.performerId !== undefined
                && !(await performerExists(client, changes.performerId))) {
                throw createApiError(`Performer ${changes.performerId} not found`, 400);
            }

            const event = await updateEvent(client, id, changes);
            if (!event) {
                throw createApiError(`Event ${id} not found`, 404);
            }
            await emit(client, "event.updated", event);
            return event;
        });
    } catch (error) {
        if (error.isApiError) throw error;
        rethrowPgError(error, "update", "event");
    }
};

export const removeEvent = async (id) => {
    try {
        return await withTransaction(async (client) => {
            if (!(await lockEvent(client, id))) {
                throw createApiError(`Event ${id} not found`, 404);
            }

            // Soft delete passes every FK, so Postgres will not stop this on its
            // own — anything still pointing at the event has to be checked here.
            const bookings = await countLiveBookings(client, id);
            if (bookings > 0) {
                throw createApiError(
                    `Cannot delete event ${id}: ${bookings} pending or confirmed booking(s)`,
                    409
                );
            }
            const sold = await countBookedTickets(client, id);
            if (sold > 0) {
                throw createApiError(
                    `Cannot delete event ${id}: ${sold} ticket(s) already sold`,
                    409
                );
            }

            const deleted = await softDeleteEvent(client, id);
            if (!deleted) {
                throw createApiError(`Event ${id} not found`, 404);
            }
            await emit(client, "event.deleted", { id: deleted.id });
            return { id: deleted.id };
        });
    } catch (error) {
        if (error.isApiError) throw error;
        rethrowPgError(error, "delete", "event");
    }
};
