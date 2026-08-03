import { checkAndIncrement } from "../repositories/rateLimit.repository.js";
import { createApiError } from "../utils/apiError.js";

// N and window per group, not per route — /queue/join, /bookings/reserve, and
// /bookings/confirm all share the "booking" bucket rather than each getting
// its own independent quota, since they're the same caller hammering the same
// underlying capacity from three different endpoints.
const RATE_LIMIT_GROUPS = {
    search: {
        limit: Number(process.env.SEARCH_RATE_LIMIT) || 20,
        windowMs: Number(process.env.SEARCH_RATE_WINDOW_MS) || 10000,
    },
    booking: {
        limit: Number(process.env.BOOKING_RATE_LIMIT) || 10,
        windowMs: Number(process.env.BOOKING_RATE_WINDOW_MS) || 10000,
    },
};

// Fails OPEN: a Redis outage must not take down search/booking traffic just
// because the limiter's own backing store is unreachable. The alternative
// (fail closed) turns a Redis blip into a site-wide 429 storm — worse than
// briefly under-enforcing a quota, the same "availability over strictness"
// call the hold mechanism makes for its own Redis dependency.
export const enforceRateLimit = async (req, group, identityKey) => {
    const config = RATE_LIMIT_GROUPS[group];
    const key = `ratelimit:${group}:${identityKey}`;

    let result;
    try {
        result = await checkAndIncrement({ key, windowMs: config.windowMs, limit: config.limit });
    } catch (err) {
        console.error(`[${req.correlationId}] rate limiter check failed, failing open:`, err.message);
        return;
    }

    if (!result.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        const err = createApiError(`Rate limit exceeded for ${group}`, 429);
        err.retryAfter = retryAfterSeconds;
        throw err;
    }
};
