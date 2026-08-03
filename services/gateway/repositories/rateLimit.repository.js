import { randomUUID } from "node:crypto";
import redis from "../config/redis.js";
import { REDIS_TIME_LUA } from "../../../shared/availability.js";

// Sliding-window LOG, not a fixed bucket or a weighted counter: every request
// timestamp within the window is its own ZSET entry, so the window boundary
// moves continuously with `now` rather than resetting hard at a calendar-
// aligned edge. A fixed window (e.g. "reset every :00 seconds") lets a client
// send N requests in the last millisecond of one window and N more in the
// first millisecond of the next — 2N requests in a blink, despite never
// exceeding N "per window" by the letter of a naive check. The log has no such
// edge: at any instant, ZCARD after purging is the exact count in the trailing
// `windowMs`, not an approximation.
//
// `TIME` read inside the script (shared REDIS_TIME_LUA, same one the hold
// mechanism uses) rather than a `now` argument from the calling instance —
// two gateway instances with skewed clocks would otherwise purge and compare
// against two different ideas of "now," and could disagree about the same
// counter. One clock reading, shared by both the purge and the write, same
// reasoning as DECISIONS.md's "clock authority for hold expiry."
//
// Purge, count, and (conditionally) add all happen inside one script — Redis
// runs a script to completion before any other command, so this is the atomic
// "increment + check" the requirement asks for: two concurrent requests against
// the same key cannot both read "count = N-1" and both be admitted into what
// would then be slot N.
const SLIDING_WINDOW_LUA = `
${REDIS_TIME_LUA}
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]

redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. (nowMs - windowMs))
local count = redis.call('ZCARD', key)

if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfterMs = windowMs
  if oldest[2] then
    retryAfterMs = (tonumber(oldest[2]) + windowMs) - nowMs
  end
  return cjson.encode({ allowed = false, retryAfterMs = retryAfterMs })
end

redis.call('ZADD', key, nowMs, member)
-- Cleanup only — correctness comes from the score-based purge above, same
-- "TTL as memory reclamation, not as the mechanism" pattern as the hold keys.
redis.call('PEXPIRE', key, windowMs)

return cjson.encode({ allowed = true })
`;

// `member` only needs to be unique, never compared as a value — the ranking
// and expiry logic works entirely off the ZSET score (nowMs), so a random id
// is enough; it does not need to encode a timestamp itself.
export const checkAndIncrement = async ({ key, windowMs, limit }) => {
    const raw = await redis.eval(SLIDING_WINDOW_LUA, {
        keys: [key],
        arguments: [String(windowMs), String(limit), randomUUID()],
    });
    return JSON.parse(raw);
};
