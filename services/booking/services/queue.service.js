import { createApiError } from "../utils/apiError.js";
import { signQueueToken, verifyQueueToken } from "../utils/queueToken.js";
import { signAdmissionToken } from "../utils/admissionToken.js";
import { getEvent } from "../repositories/booking.repository.js";
import {
    joinQueue,
    getPosition,
    countRecentDepartures,
    isAdmitted,
    isSoldOut,
} from "../repositories/queue.repository.js";

// Two window sizes rather than one — a long baseline and a shorter recent
// signal — so the two rates they produce can genuinely differ instead of one
// number reported with false confidence. `SHORT` is capped at `LONG` so a
// misconfigured env (a short window bigger than the long one) can't invert
// the range.
const LONG_WINDOW_MS = Number(process.env.QUEUE_DRAIN_WINDOW_MS) || 300000;
const SHORT_WINDOW_MS = Math.min(60000, LONG_WINDOW_MS);

export const join = async ({ eventId, userId }) => {
    const event = await getEvent(eventId);
    if (!event) {
        throw createApiError(`Event ${eventId} not found`, 404);
    }

    const result = await joinQueue(eventId, userId);
    // Reissued on every join, including a repeat one — the token is stateless
    // (nothing server-side records "the" current token for a user), so a
    // reissue costs nothing and there's no staleness to worry about: any token
    // whose claims still match a live queue membership verifies the same way.
    const token = signQueueToken({ userId, eventId });
    return { token, position: result.position, joined: result.joined };
};

// No departures observed yet in EITHER window is reported as exactly that —
// not `position / assumed_rate`. Before the admitter runs, this is always the
// case; the honest answer is "not enough data," not a number that looks
// precise but is actually a guess dressed up as a measurement.
const estimateEta = async (eventId, position) => {
    const [longCount, shortCount] = await Promise.all([
        countRecentDepartures(eventId, LONG_WINDOW_MS),
        countRecentDepartures(eventId, SHORT_WINDOW_MS),
    ]);

    const rates = [
        longCount / (LONG_WINDOW_MS / 1000),
        shortCount / (SHORT_WINDOW_MS / 1000),
    ].filter((rate) => rate > 0);

    if (rates.length === 0) {
        return { etaSecondsMin: null, etaSecondsMax: null, etaMessage: "Not enough drain data yet" };
    }

    return {
        etaSecondsMin: Math.ceil(position / Math.max(...rates)),
        etaSecondsMax: Math.ceil(position / Math.min(...rates)),
    };
};

export const getQueuePosition = async ({ eventId, userId, token }) => {
    let claims;
    try {
        claims = verifyQueueToken(token);
    } catch {
        throw createApiError("Invalid or expired queue token", 401);
    }

    // Both checks are 401, deliberately, not 403 or 404 — a mismatched token
    // proves nothing about the caller's right to ask, the same way a
    // tampered access token does elsewhere in this system. It does not say
    // "this queue entry doesn't exist" (404) or "you're not allowed" (403);
    // it says "this credential isn't yours."
    if (claims.userId !== userId) {
        throw createApiError("This queue token does not belong to you", 401);
    }
    if (String(claims.eventId) !== String(eventId)) {
        throw createApiError("This queue token is for a different event", 401);
    }

    const position = await getPosition(eventId, userId);
    if (position !== null) {
        const eta = await estimateEta(eventId, position);
        return { status: "waiting", position, ...eta };
    }

    // No longer in the waiting ZSET — the admitter (a separate process) is the
    // only thing that removes members, and it does so for exactly one of two
    // reasons: it let this user in, or the event sold out and drained
    // everyone. Checked in this order because a race where both happen to be
    // true (sold out right as this user was admitted) should still favor
    // telling them the good news — they have a real, usable admission token.
    if (await isAdmitted(eventId, userId)) {
        const admissionToken = signAdmissionToken({ userId, eventId });
        return { status: "admitted", admissionToken };
    }
    if (await isSoldOut(eventId)) {
        return { status: "sold_out" };
    }

    // Neither admitted nor sold out, and not waiting — this user was never in
    // this event's queue at all.
    throw createApiError("You are not in this event's queue", 404);
};
