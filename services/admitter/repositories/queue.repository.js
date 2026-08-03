import redis from "../config/redis.js";
import { REDIS_TIME_LUA, LUA_PURGE_HELPERS } from "../../../shared/availability.js";
import {
    queueKey,
    admittedKey,
    departuresKey,
    soldOutKey,
    ACTIVE_QUEUES_KEY,
} from "../../../shared/queue.js";

export const getActiveEventIds = async () => redis.sMembers(ACTIVE_QUEUES_KEY);

export const getQueueLength = async (eventId) => redis.zCard(queueKey(eventId));

// Only counts admissions that haven't expired — a caller who was admitted and
// then sat on their hands past ADMISSION_TTL_SECONDS gives their budget slot
// back automatically, without anything needing to explicitly evict them.
export const countActiveAdmissions = async (eventId) => {
    const now = Date.now();
    return redis.zCount(admittedKey(eventId), now, "+inf");
};

// Pops the lowest-scored (earliest-joined) `count` members off the waiting
// queue and grants them admission, in one script. Clock read via Redis TIME
// (shared REDIS_TIME_LUA), same reasoning as the hold TTL and the rate
// limiter: the expiry this writes has to come from one authoritative clock,
// not this instance's own `Date.now()`, since Booking Service's later
// `isAdmitted` check (services/booking/repositories/queue.repository.js)
// reads that same expiry from a different process entirely.
//
// Each admitted user is also recorded as a departure — this is the caller Day
// 1's ETA math was built for but never had: admission is the event that
// actually drains the waiting queue, so it's what should feed the measured
// drain rate.
const ADMIT_BATCH_LUA = `
${REDIS_TIME_LUA}
local count = tonumber(ARGV[1])
local expiresAt = nowMs + tonumber(ARGV[2])

local candidates = redis.call('ZRANGE', KEYS[1], 0, count - 1)
for _, userId in ipairs(candidates) do
  redis.call('ZREM', KEYS[1], userId)
  redis.call('ZADD', KEYS[2], expiresAt, userId)
  redis.call('ZADD', KEYS[3], nowMs, userId)
end

redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. (nowMs - tonumber(ARGV[3])))

return cjson.encode(candidates)
`;

export const admitBatch = async (eventId, count, admissionTtlMs, departuresWindowMs) => {
    const raw = await redis.eval(ADMIT_BATCH_LUA, {
        keys: [queueKey(eventId), admittedKey(eventId), departuresKey(eventId)],
        arguments: [String(count), String(admissionTtlMs), String(departuresWindowMs)],
    });
    return JSON.parse(raw);
};

// Drains the ENTIRE remaining queue at once rather than one admit-batch call —
// once an event is sold out, nobody left waiting is ever going to be admitted,
// so there is no reason to trickle them out over more ticks. Chunked removal
// (the shared LUA_PURGE_HELPERS `removeChunked`) rather than a single ZREM
// with every member unpacked — at the scale this system is meant to survive
// ("1,000,000 users"), unpacking tens of thousands of members in one Lua call
// risks the interpreter's own argument stack, the same concern the hold
// scripts already guard against.
const MARK_SOLD_OUT_LUA = `
${LUA_PURGE_HELPERS}
redis.call('SET', KEYS[2], '1')
local remaining = redis.call('ZRANGE', KEYS[1], 0, -1)
removeChunked('ZREM', KEYS[1], remaining)
return #remaining
`;

export const markSoldOutAndDrain = async (eventId) => {
    const drained = await redis.eval(MARK_SOLD_OUT_LUA, {
        keys: [queueKey(eventId), soldOutKey(eventId)],
        arguments: [],
    });
    return Number(drained);
};

// Once both the waiting queue and the admitted set are empty, this event no
// longer needs the admitter's attention — deregistering keeps the active-queue
// registry from growing forever with events that finished selling out or
// draining long ago.
export const deregisterIfDrained = async (eventId) => {
    const [queueLen, admittedCount] = await Promise.all([
        redis.zCard(queueKey(eventId)),
        redis.zCard(admittedKey(eventId)),
    ]);
    if (queueLen === 0 && admittedCount === 0) {
        await redis.sRem(ACTIVE_QUEUES_KEY, String(eventId));
    }
};
