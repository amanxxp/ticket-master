import { createApiError } from "../utils/apiError.js";
import { encodeHoldId } from "../utils/holdId.js";
import { HOLD_TTL_SECONDS } from "../../../shared/availability.js";
import { publishAvailabilityChange } from "../utils/publishAvailability.js";
import { claimHold, releaseHold } from "../repositories/hold.repository.js";
import {
    countUserTicketsForEvent,
    getEvent,
    getTicketsForHold,
} from "../repositories/booking.repository.js";

export const reserve = async ({ userId, eventId, ticketIds }) => {
    const event = await getEvent(eventId);
    if (!event) {
        throw createApiError(`Event ${eventId} not found`, 404);
    }

    const tickets = await getTicketsForHold(eventId, ticketIds);

    if (tickets.length !== ticketIds.length) {
        const found = new Set(tickets.map((t) => t.id));
        const missing = ticketIds.filter((id) => !found.has(id));
        throw createApiError(
            `Ticket(s) ${missing.join(", ")} not found for event ${eventId}`,
            404
        );
    }

    const sold = tickets.filter((t) => t.status !== "available");
    if (sold.length > 0) {
        throw createApiError(
            `Ticket(s) ${sold.map((t) => t.id).join(", ")} are already booked`,
            409
        );
    }

    // Read before the script, so a confirm landing in between makes the cap
    // check stale by at most one booking. Tolerated rather than fixed: closing it
    // needs the count inside the same store as the claim, which would mean
    // mirroring booked state into Redis and giving the cap a second source of
    // truth. The confirm path enforces the cap independently, which is where an
    // over-cap attempt is actually stopped.
    const confirmedCount = await countUserTicketsForEvent(userId, eventId);

    const result = await claimHold({
        eventId,
        userId,
        ticketIds,
        ttlSeconds: HOLD_TTL_SECONDS,
        cap: event.maxTicketsPerUser,
        confirmedCount,
    });

    switch (result.status) {
        case "CLAIMED":
        case "EXISTING":
            // Only a real claim is a change worth telling open streams about —
            // EXISTING means the store did not move, so publishing it would push
            // a no-op update to every client watching the event.
            if (result.status === "CLAIMED") {
                await publishAvailabilityChange(eventId, "reserve", ticketIds);
            }
            return {
                holdId: encodeHoldId(eventId, ticketIds),
                eventId,
                ticketIds,
                expiresAt: new Date(Number(result.expiresAt)).toISOString(),
                // Lets a double-clicking client tell "your hold, unchanged" from
                // "hold created" without comparing timestamps.
                alreadyHeld: result.status === "EXISTING",
            };

        case "CONFLICT":
            throw createApiError(
                `Ticket(s) ${result.tickets.join(", ")} are held by another user`,
                409
            );

        case "OVERLAP":
            throw createApiError(
                `Ticket(s) ${result.tickets.join(", ")} are already in one of your holds; ` +
                    `release that hold before reserving a different set`,
                409
            );

        case "CAP_EXCEEDED":
            throw createApiError(
                `Limit of ${result.cap} ticket(s) per user for this event; ` +
                    `${result.remaining} remaining`,
                422
            );

        default:
            throw createApiError(`Unexpected hold result: ${result.status}`, 500);
    }
};

export const release = async ({ userId, eventId, ticketIds }) => {
    const result = await releaseHold({ eventId, userId, ticketIds });

    switch (result.status) {
        case "RELEASED":
            // ticketIds requested, not the exact "ours" subset the Lua script
            // freed — a superset is harmless here: the delta path recomputes
            // real status per ticket, so naming one that was already free just
            // costs an extra no-op entry in the pushed payload.
            await publishAvailabilityChange(eventId, "release", ticketIds);
            return { eventId, ticketIds, released: result.released };

        // 404 rather than 403 on someone else's hold: a 403 would confirm the
        // seat is held and by whom it is not, which is inventory intelligence a
        // caller with no claim on it should not get. Same reasoning as
        // getBooking's 404-on-mismatch.
        case "NOT_OWNER":
        case "NOT_FOUND":
            throw createApiError("Hold not found", 404);

        default:
            throw createApiError(`Unexpected release result: ${result.status}`, 500);
    }
};
