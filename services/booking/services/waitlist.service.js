import { createApiError } from "../utils/apiError.js";
import { getEvent } from "../repositories/booking.repository.js";
import {
    joinWaitlist,
    getWaitlistPosition,
    getLiveEntry,
    leaveWaitlist,
    EXCLUSION_VIOLATION,
} from "../repositories/waitlist.repository.js";

export const join = async ({ eventId, userId }) => {
    const event = await getEvent(eventId);
    if (!event) {
        throw createApiError(`Event ${eventId} not found`, 404);
    }

    try {
        const entry = await joinWaitlist(eventId, userId);
        return {
            waitlistId: String(entry.id),
            eventId,
            status: entry.status,
            position: await getWaitlistPosition(eventId, userId),
            joined: true,
        };
    } catch (error) {
        // The EXCLUDE constraint refused a second live entry. Reported as an
        // unchanged 200 rather than a 409: the caller's intent — "be on this
        // waitlist" — is satisfied, and they gain nothing from an error. Mirrors
        // the reserve path's "200 on unchanged retry" convention.
        if (error.code === EXCLUSION_VIOLATION) {
            const existing = await getLiveEntry(eventId, userId);
            return {
                waitlistId: String(existing.id),
                eventId,
                status: existing.status,
                position: await getWaitlistPosition(eventId, userId),
                claimExpiresAt: existing.claimExpiresAt,
                joined: false,
            };
        }
        throw error;
    }
};

export const getStatus = async ({ eventId, userId }) => {
    const entry = await getLiveEntry(eventId, userId);
    if (!entry) {
        throw createApiError("You are not on this event's waitlist", 404);
    }

    // A 'notified' entry whose window has already lapsed is reported as expired
    // rather than as a live claim — the same "the timestamp decides, not whether
    // a sweeper has run yet" rule the hold ZSETs use. The sweeper only reclaims
    // the row; it is not what makes the claim dead.
    if (entry.status === "notified" && new Date(entry.claimExpiresAt).getTime() < Date.now()) {
        return { eventId, status: "expired", position: null };
    }

    return {
        eventId,
        status: entry.status,
        position: await getWaitlistPosition(eventId, userId),
        claimExpiresAt: entry.claimExpiresAt ?? null,
    };
};

export const leave = async ({ eventId, userId }) => {
    const removed = await leaveWaitlist(eventId, userId);
    if (!removed) {
        throw createApiError("You are not on this event's waitlist", 404);
    }
    return { eventId, status: "cancelled" };
};
