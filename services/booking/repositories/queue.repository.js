import redis from "../config/redis.js";
import { REDIS_TIME_LUA } from "../../../shared/availability.js";

const queueKey = (eventId) => `queue:{evt:${eventId}}`;
const seqKey = (eventId) => `queue:{evt:${eventId}}:seq`;
const departuresKey = (eventId) => `queue:{evt:${eventId}}:departures`;

// Atomic join-or-return-existing in one round trip: ZSCORE-then-ZADD as two
// separate commands would let two concurrent joins from the SAME user both
// observe "not yet a member" and both insert — "joining twice takes one slot"
// requires the check and the insert to be indivisible, same reasoning as the
// hold-claim and rate-limit scripts elsewhere in this codebase.
//
// The score is a Redis-side INCR sequence, not a timestamp — two joins in the
// same millisecond would tie on a timestamp score, and ZRANK on a tie doesn't
// guarantee arrival order. A sequence counter can't collide regardless of
// clock resolution, which is what makes "position never increases" provable:
// nobody already in the ZSET can ever be assigned a lower score after the fact.
const JOIN_LUA = `
local existing = redis.call('ZSCORE', KEYS[1], ARGV[1])
if existing then
  local rank = redis.call('ZRANK', KEYS[1], ARGV[1])
  return cjson.encode({ joined = false, position = rank + 1 })
end

local seq = redis.call('INCR', KEYS[2])
redis.call('ZADD', KEYS[1], seq, ARGV[1])
local rank = redis.call('ZRANK', KEYS[1], ARGV[1])
return cjson.encode({ joined = true, position = rank + 1 })
`;

export const joinQueue = async (eventId, userId) => {
    const raw = await redis.eval(JOIN_LUA, {
        keys: [queueKey(eventId), seqKey(eventId)],
        arguments: [userId],
    });
    return JSON.parse(raw);
};

// null means "not in the queue" — either never joined, or already departed
// (admitted, expired, or the event sold out and drained them). The caller
// turns that into 404, not a fabricated position.
export const getPosition = async (eventId, userId) => {
    const rank = await redis.zRank(queueKey(eventId), userId);
    return rank === null ? null : rank + 1;
};

// Removes the user from the live queue and records the departure for the
// drain-rate measurement below. Nothing in Day 1's own scope calls this yet —
// there is no admitter until Day 2 — but the read side (drain rate / ETA) is
// built against this real data shape now, not a stubbed one swapped later.
const RECORD_DEPARTURE_LUA = `
${REDIS_TIME_LUA}
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], nowMs, ARGV[1])
-- Prune anything older than the measurement window on the way out — cleanup
-- only, correctness comes from the score-range read in getDrainRate, not from
-- what has or hasn't been pruned yet.
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', '(' .. (nowMs - tonumber(ARGV[2])))
`;

export const recordDeparture = async (eventId, userId, windowMs) => {
    await redis.eval(RECORD_DEPARTURE_LUA, {
        keys: [queueKey(eventId), departuresKey(eventId)],
        arguments: [userId, String(windowMs)],
    });
};

// Departures in the trailing `windowMs`, for the ETA calculation. Plain
// ZCOUNT against a client-side `now` rather than a script-read Redis clock —
// unlike the rate limiter, a few milliseconds of cross-instance clock skew
// here only nudges an already-approximate ETA, it can't turn into an
// over-admission the way it would for a hard limit.
export const countRecentDepartures = async (eventId, windowMs) => {
    const now = Date.now();
    return redis.zCount(departuresKey(eventId), now - windowMs, now);
};

export const getQueueLength = async (eventId) => redis.zCard(queueKey(eventId));
