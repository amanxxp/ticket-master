import { createApiError } from "../utils/apiError.js";
import { rethrowPgError } from "../utils/helper.js";
import { withTransaction } from "../utils/transaction.js";
import { decodeEventCursor } from "../utils/eventCursor.js";
import { insertOutboxEvent } from "../repositories/outbox.repository.js";
import { getCachedEvent, setCachedEvent, invalidateCachedEvent } from "../repositories/eventCache.repository.js";
import {
    insertEvent,
    getEventsByCursor,
    getEventsByOffset,
    getEventById,
    updateEvent,
    softDeleteEvent,
    lockEvent,
    venueExistsActive,
    performerExists,
    getVenueSearchFields,
    getPerformerName,
    countBookedTickets,
    countLiveBookings,
} from "../repositories/event.repository.js";

const emit = (client, type, event, extra) =>
    insertOutboxEvent(client, {
        aggregateType: "event",
        aggregateId: event.id,
        payload: { type, event, ...extra },
    });

// Denormalizes venue/performer name (+ venue location) onto the outbox payload
// at write time, so the search index poller never needs its own join back to
// `venues`/`performers` — its only table is the outbox. Read with
// getVenueSearchFields/getPerformerName, not venueExistsActive/performerExists:
// those filter out a since-retired venue, which is correct for validating a
// *new* choice but wrong here — an existing event's search document must keep
// showing its venue's name even after that venue is soft-deleted, same as
// getEventById's join already does for the read API.
const searchEnrichment = async (client, venueId, performerId) => {
    const venue = await getVenueSearchFields(client, venueId);
    const performerName = await getPerformerName(client, performerId);
    return {
        venueName: venue?.name ?? null,
        venueLocation: venue?.location ?? null,
        performerName,
    };
};

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
            const enrichment = await searchEnrichment(client, event.venueId, event.performerId);
            await emit(client, "event.created", event, enrichment);
            return event;
        });
    } catch (error) {
        if (error.isApiError) throw error;
        rethrowPgError(error, "create", "event");
    }
};

// `page` selects offset mode, `cursor` selects keyset mode; the validator's
// .nand() already guarantees at most one is present. No `page`/`cursor` at all
// defaults to keyset from the start (cursor = null) — the primary "browse
// upcoming events" path, since it's the one that stays correct under concurrent
// writes.
export const getAllEvents = async ({ page, cursor, ...filters }) => {
    if (page !== undefined) {
        return await getEventsByOffset({ page, ...filters });
    }
    const decoded = cursor !== undefined ? decodeEventCursor(cursor) : null;
    return await getEventsByCursor({ cursor: decoded, ...filters });
};

// Cache-aside: check Redis first, fall through to Postgres on a miss, populate
// Redis for next time. Both paths are timed and logged so a hit's latency is
// visible against a miss's, per the "measurably faster" acceptance criterion.
// getEventById's projection already excludes seat_map and never touches Redis
// hold data — this cache only ever holds the static event body, never
// availability, so there is no separate "don't cache the live part" branch to
// get wrong here; there is simply nothing live in what this function reads.
export const getEvent = async (id) => {
    const cacheStart = Date.now();
    const cached = await getCachedEvent(id);
    if (cached) {
        console.log(`[event-cache] HIT id=${id} (${Date.now() - cacheStart}ms)`);
        return cached;
    }

    const dbStart = Date.now();
    const event = await getEventById(id);
    console.log(`[event-cache] MISS id=${id}, db fetch (${Date.now() - dbStart}ms)`);

    if (!event) {
        throw createApiError(`Event ${id} not found`, 404);
    }

    await setCachedEvent(id, event);
    return event;
};

export const editEvent = async (id, changes) => {
    try {
        const updated = await withTransaction(async (client) => {
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
            // Re-fetched for whichever venue/performer the event now points at,
            // whether or not this particular edit touched them — a `name`-only
            // update must not leave the search document's venue/performer stale.
            const enrichment = await searchEnrichment(client, event.venueId, event.performerId);
            await emit(client, "event.updated", event, enrichment);
            return event;
        });

        // After commit, not inside the transaction callback above: a later
        // throw in there still rolls the write back, and invalidating first
        // would evict a perfectly valid cached value for a change that never
        // happened. Stale event data after a real edit is the failure this
        // guards against — REQUIREMENTS.md is explicit that it counts as a bug.
        await invalidateCachedEvent(id);

        return updated;
    } catch (error) {
        if (error.isApiError) throw error;
        rethrowPgError(error, "update", "event");
    }
};

export const removeEvent = async (id) => {
    try {
        const result = await withTransaction(async (client) => {
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

        await invalidateCachedEvent(id);

        return result;
    } catch (error) {
        if (error.isApiError) throw error;
        rethrowPgError(error, "delete", "event");
    }
};
