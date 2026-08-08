import redis from "../config/redis.js";
import { REDIS_TIME_LUA } from "../../../shared/availability.js";
import {
    queueKey,
    queueSeqKey,
    departuresKey,
    admittedKey,
    soldOutKey,
    registrantsKey,
    drawDoneKey,
    ACTIVE_QUEUES_KEY,
    DRAW_SCORE_LUA,
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

// ---------------------------------------------------------------- lottery mode

// Registration window. SADD is already idempotent, so registering twice takes
// one slot for free — no check-then-insert, therefore no race to make atomic.
// Returns 1 on first registration, 0 on a repeat, which is what lets the
// service layer distinguish "you're in" from "you were already in" without a
// second round trip.
export const registerForDraw = async (eventId, userId) =>
    redis.sAdd(registrantsKey(eventId), userId);

export const isRegistered = async (eventId, userId) =>
    redis.sIsMember(registrantsKey(eventId), userId);

export const countRegistrants = async (eventId) => redis.sCard(registrantsKey(eventId));

export const isDrawDone = async (eventId) => (await redis.exists(drawDoneKey(eventId))) === 1;

// Scores every registrant into the waiting ZSET, once. The `draw-done` flag is
// set inside the same script that does the scoring, so two concurrent first
// requests after sale-open cannot both draw — a second draw would re-rank users
// who have already been shown a position, and a position that moves upward is
// the one failure this queue is built to exclude.
//
// The whole registration set is scored in a single script, which blocks Redis
// for its duration. That is acceptable here (thousands of registrants, single
// digit milliseconds) and is the honest scaling limit of this implementation:
// past roughly 10^5 registrants the draw belongs in the admitter worker,
// chunked across ticks, with `GET /queue/position` reporting a "drawing" state
// until it finishes. It is NOT correct to chunk it across separate requests
// while showing positions — partial ranks move.
const DRAW_LUA = `
${DRAW_SCORE_LUA}

local queue        = KEYS[1]
local registrants  = KEYS[2]
local drawDone     = KEYS[3]
local activeQueues = KEYS[4]

local seed    = ARGV[1]
local eventId = ARGV[2]

if redis.call('EXISTS', drawDone) == 1 then
  return cjson.encode({ drawn = false, size = redis.call('ZCARD', queue) })
end

local members = redis.call('SMEMBERS', registrants)
for i = 1, #members do
  redis.call('ZADD', queue, drawScore(seed, members[i]), members[i])
end

redis.call('SET', drawDone, '1')
if #members > 0 then
  redis.call('SADD', activeQueues, eventId)
end

return cjson.encode({ drawn = true, size = #members })
`;

export const runDraw = async (eventId, seed) => {
    const raw = await redis.eval(DRAW_LUA, {
        keys: [
            queueKey(eventId),
            registrantsKey(eventId),
            drawDoneKey(eventId),
            ACTIVE_QUEUES_KEY,
        ],
        arguments: [seed, String(eventId)],
    });
    return JSON.parse(raw);
};

// A latecomer, arriving after the draw has already run — they missed the
// registration window entirely.
//
// They are appended BEHIND every drawn member, not scored by `drawScore`. This
// is the one place the two fairness properties genuinely conflict, and
// monotonicity wins:
//
//   · Scoring a latecomer by hash would sometimes place them mid-queue, which
//     shifts the rank of everyone behind that slot UP BY ONE. Those users have
//     already been shown their position. A position that worsens is the single
//     failure this queue exists to exclude (`DECISIONS.md` #55), and it would be
//     caused here by someone else's arrival — the most corrosive version of it.
//   · Appending cannot move anyone: a member added at the tail changes no
//     existing rank.
//
// The cost is that arrival time DOES determine order among latecomers. That is
// accepted and is not the property Day 3 is about: the draw exists to make the
// registration window fair to everyone who entered it, not to reward arriving
// after it closed. Latecomers are strictly behind registrants, and FIFO among
// themselves.
//
// Scores are offset past 2^52 — one above the widest value `drawScore` can
// produce (13 hex chars) — so a latecomer can never tie with or undercut a drawn
// member no matter what the seed hashed to.
const LATE_JOIN_LUA = `
local queue        = KEYS[1]
local seqKey       = KEYS[2]
local registrants  = KEYS[3]
local activeQueues = KEYS[4]

local userId  = ARGV[1]
local eventId = ARGV[2]

local LATE_BASE = 4503599627370496  -- 2^52, above every possible drawScore

if redis.call('ZSCORE', queue, userId) then
  return redis.call('ZRANK', queue, userId) + 1
end

local seq = redis.call('INCR', seqKey)
redis.call('SADD', registrants, userId)
redis.call('SADD', activeQueues, eventId)
-- %.0f for the same reason as drawScore: a bare number here would reach ZADD as
-- "4.5035996273705e+15" and every latecomer would collapse onto one score.
redis.call('ZADD', queue, string.format('%.0f', LATE_BASE + seq), userId)
return redis.call('ZRANK', queue, userId) + 1
`;

export const lateJoinDraw = async (eventId, userId) => {
    const position = await redis.eval(LATE_JOIN_LUA, {
        keys: [
            queueKey(eventId),
            queueSeqKey(eventId),
            registrantsKey(eventId),
            ACTIVE_QUEUES_KEY,
        ],
        arguments: [userId, String(eventId)],
    });
    return Number(position);
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
