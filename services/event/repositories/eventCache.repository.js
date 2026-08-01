import redis from "../config/redis.js";

// Separate prefix from the hold keys (`hold:{evt:...}`) and the pub/sub channel
// (`availability:event:...`) — three different Redis-backed concerns on the
// same instance, none of which should be able to collide on a key.
const CACHE_PREFIX = "cache:event:";
const cacheKey = (id) => `${CACHE_PREFIX}${id}`;

// A safety net for a missed invalidation, not the correctness mechanism —
// PUT/DELETE invalidate the key directly (see event.service.js), so this only
// bounds how stale a read can get if that invalidation somehow never ran (e.g.
// the process crashed between commit and the Redis DEL). Short on purpose: a
// cache-aside layer with active invalidation doesn't need a long TTL to be
// correct, only long enough to be worth the round trip it saves.
export const EVENT_CACHE_TTL_SECONDS = Number(process.env.EVENT_CACHE_TTL_SECONDS) || 60;

// Every function here fails open: a cache read/write/invalidate error is logged
// and swallowed, never thrown. The cache is an optimization over Postgres, not
// a second source of truth — a request must still succeed (correctly, from the
// DB) when Redis is unreachable, same "Redis loss is survivable" invariant the
// hold mechanism holds itself to.
export const getCachedEvent = async (id) => {
    try {
        const raw = await redis.get(cacheKey(id));
        return raw ? JSON.parse(raw) : null;
    } catch (err) {
        console.error(`Event cache read failed for ${id}:`, err.message);
        return null;
    }
};

export const setCachedEvent = async (id, event) => {
    try {
        await redis.set(cacheKey(id), JSON.stringify(event), { EX: EVENT_CACHE_TTL_SECONDS });
    } catch (err) {
        console.error(`Event cache write failed for ${id}:`, err.message);
    }
};

// Called by PUT and DELETE after their transaction commits — never speculatively
// before, or a rolled-back write would evict a perfectly valid cached value for
// nothing.
export const invalidateCachedEvent = async (id) => {
    try {
        await redis.del(cacheKey(id));
    } catch (err) {
        console.error(`Event cache invalidation failed for ${id}:`, err.message);
    }
};
