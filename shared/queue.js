// Redis key naming shared between Booking Service (owns the waiting queue —
// join/position) and the Admitter worker (the only writer of admission and
// sold-out state, the only reader that ever pops the waiting queue). Same
// drift risk as shared/availability.js's hold keys: two processes referring
// to "the same queue" must agree on identical key strings without either one
// guessing at the other's convention.

export const ADMISSION_TTL_SECONDS = Number(process.env.ADMISSION_TTL_SECONDS) || 900;

const tag = (eventId) => `queue:{evt:${eventId}}`;

export const queueKey = (eventId) => tag(eventId);
export const queueSeqKey = (eventId) => `${tag(eventId)}:seq`;
export const departuresKey = (eventId) => `${tag(eventId)}:departures`;

// ZSET, member=userId, score=admission expiry (ms) — same "score carries
// expiry, not a per-key TTL" pattern as the hold ZSETs, for the same reason:
// bulk membership ("is anyone's admission still live") has to stay an O(1)
// round trip, and an expired admission must never be observable as live just
// because nothing has swept it yet.
export const admittedKey = (eventId) => `${tag(eventId)}:admitted`;

// A plain flag, not a per-user set — once an event is sold out, every
// remaining queue member gets the same answer, so there is nothing per-user
// to track.
export const soldOutKey = (eventId) => `${tag(eventId)}:soldout`;

// Lottery mode only (Week 5 Day 3). A plain SET, not a ZSET: during the
// registration window there is deliberately no order to store — order is what
// the draw invents at sale-open, and keeping an arrival-ordered structure here
// would be an arrival order somebody could later be tempted to fall back on.
export const registrantsKey = (eventId) => `${tag(eventId)}:registrants`;

// Set once the registration set has been scored into the waiting ZSET. Guards
// the draw so it runs exactly once — a second draw would re-rank users who have
// already been shown a position.
export const drawDoneKey = (eventId) => `${tag(eventId)}:draw-done`;

// Global registry (not per-event) of events with a non-empty waiting queue —
// lets the admitter discover which events need attention with one SMEMBERS
// call instead of a KEYS/SCAN over the whole keyspace, which is unsafe to run
// against a live instance and not O(1) either.
export const ACTIVE_QUEUES_KEY = "queue:active-events";

// The lottery score, defined once, in Lua, so the draw is computed inside the
// same atomic script that writes it — nothing about a user's place can be
// derived on one machine and written by another.
//
// `redis.sha1hex` is used rather than an HMAC because Redis' Lua sandbox ships
// no HMAC primitive; the property actually needed here is not
// forgery-resistance-under-a-known-key but *unpredictability before the seed
// exists*. The seed is 32 bytes of CSPRNG output created at sale-open, so
// pre-computing your own score is infeasible no matter how well SHA-1's
// internals are understood: you cannot hash a seed you do not have.
//
// 13 hex chars = 52 bits, which lands exactly inside a float64's integer range —
// ZSET scores are doubles, so a wider slice would round and silently collapse
// distinct users onto one score. On the astronomically unlikely tie, Redis
// falls back to lexicographic member order, which is stable across reads and
// therefore still monotonic.
// `%.0f`, not the number itself, is load-bearing. Lua 5.1 stringifies numbers
// with `%.14g`, and `redis.call` stringifies every argument — so passing a 52-bit
// integer score directly gives ZADD `"4.5035996273705e+15"`, silently rounding
// distinct scores onto one value and collapsing the tail of the distribution into
// a lexicographic tiebreak. `%.0f` emits every integer digit.
//
// Scores above 2^52 are reserved for late joiners (see LATE_JOIN_LUA), which is
// why the slice stops at 13 hex chars rather than filling the double.
export const DRAW_SCORE_LUA = `
local function drawScore(seed, userId)
  return string.format('%.0f', tonumber(string.sub(redis.sha1hex(seed .. ':' .. userId), 1, 13), 16))
end
`;
