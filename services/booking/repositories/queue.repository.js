import redis from "../config/redis.js";
import { REDIS_TIME_LUA } from "../../../shared/availability.js";
import {
    queueKey,
    queueSeqKey,
    departuresKey,
    admittedKey,
    soldOutKey,
    ACTIVE_QUEUES_KEY,
} from "../../../shared/queue.js";

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
//
// Also SADDs eventId into the global active-queues registry — this is how the
// admitter (a separate process) discovers which events have anyone waiting,
// without ever scanning the keyspace.
const JOIN_LUA = `
redis.call('SADD', KEYS[3], ARGV[2])

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
        keys: [queueKey(eventId), queueSeqKey(eventId), ACTIVE_QUEUES_KEY],
        arguments: [userId, String(eventId)],
    });
    return JSON.parse(raw);
};

// null means "not currently waiting" — either never joined, or already
// departed (admitted, or the event sold out and drained the queue). The
// caller (queue.service.js) checks admission/sold-out state separately before
// deciding this means 404.
export const getPosition = async (eventId, userId) => {
    const rank = await redis.zRank(queueKey(eventId), userId);
    return rank === null ? null : rank + 1;
};

// Removes the user from the live queue and records the departure for the
// drain-rate measurement below. Called by the admitter (admission) — Day 1
// built the read side (drain rate / ETA) against this real data shape before
// anything existed to call it; Day 2 is that caller.
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

// Written by the admitter; read here so GET /queue/position can tell a caller
// who's left the waiting ZSET *why* — admitted (issue them a token) versus
// sold out (tell them plainly) versus neither (a genuine 404).
// `ZSCORE > now` mirrors the hold ZSETs' own "score carries expiry" check —
// an entry past its score is not live, whether or not anything has purged it.
export const isAdmitted = async (eventId, userId) => {
    const score = await redis.zScore(admittedKey(eventId), userId);
    return score !== null && Number(score) > Date.now();
};

export const isSoldOut = async (eventId) => {
    const flag = await redis.get(soldOutKey(eventId));
    return flag === "1";
};
