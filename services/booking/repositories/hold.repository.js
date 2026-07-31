import redis from "../config/redis.js";
import {
    holdKeys,
    holdOwnerKey,
    holdSeatsKey,
    HOLD_CONTAINER_TTL_SECONDS,
    LUA_PURGE_HELPERS,
    REDIS_TIME_LUA,
} from "../../../shared/availability.js";

// One script, not three round trips. The cap check in particular is only real if
// it is atomic with the claim: split apart, two concurrent reserves both read
// `held = cap - 1`, both pass, and the user ends up over cap. Redis executes a
// script to completion before any other command, so classify → cap → claim is
// indivisible.
const RESERVE_LUA = `
${LUA_PURGE_HELPERS}
${REDIS_TIME_LUA}

local seatsKey = KEYS[1]
local ownerKey = KEYS[2]
local userKey  = KEYS[3]

local userId       = ARGV[1]
local ttlSeconds   = tonumber(ARGV[2])
local cap          = tonumber(ARGV[3])
local confirmed    = tonumber(ARGV[4])
local containerTtl = tonumber(ARGV[5])

local tickets = {}
for i = 6, #ARGV do
  tickets[#tickets + 1] = ARGV[i]
end

local expiresAt = nowMs + (ttlSeconds * 1000)

purgeExpired(seatsKey, ownerKey, nowMs)
redis.call('ZREMRANGEBYSCORE', userKey, '-inf', '(' .. nowMs)

-- Classify against the owner hash rather than the ZSET: a seat's presence in the
-- ZSET says it is held, the hash says by whom, and the difference is what
-- separates "someone else has it" (409) from "you already have it" (idempotent).
local mine, taken, fresh = {}, {}, {}
for _, ticketId in ipairs(tickets) do
  local owner = redis.call('HGET', ownerKey, ticketId)
  if owner == false then
    fresh[#fresh + 1] = ticketId
  elseif owner == userId then
    mine[#mine + 1] = ticketId
  else
    taken[#taken + 1] = ticketId
  end
end

if #taken > 0 then
  return cjson.encode({ status = 'CONFLICT', tickets = taken })
end

-- Exact retry of a set this caller already holds. Returns the original score, so
-- a double-click neither 409s the caller against themselves nor silently extends
-- the hold — an extendable-by-retry hold is an unbounded hold.
if #fresh == 0 then
  local score = redis.call('ZSCORE', userKey, tickets[1])
  return cjson.encode({ status = 'EXISTING', expiresAt = tostring(math.floor(tonumber(score))) })
end

-- Partial overlap with the caller's own hold. Rejected rather than merged: the
-- already-held seats keep their earlier expiry while the new ones would get a
-- later one, so "the hold" would have two expiry times and no single answer for
-- expiresAt. Release and re-reserve is unambiguous.
if #mine > 0 then
  return cjson.encode({ status = 'OVERLAP', tickets = mine })
end

-- Confirmed tickets come from Postgres; live holds from Redis. Both count, or
-- the cap is trivially bypassed by confirming and reserving in alternation.
local held = redis.call('ZCARD', userKey)
if (confirmed + held + #fresh) > cap then
  local remaining = cap - confirmed - held
  if remaining < 0 then remaining = 0 end
  return cjson.encode({ status = 'CAP_EXCEEDED', remaining = remaining, cap = cap })
end

local zargs, hargs = {}, {}
for _, ticketId in ipairs(fresh) do
  zargs[#zargs + 1] = expiresAt
  zargs[#zargs + 1] = ticketId
  hargs[#hargs + 1] = ticketId
  hargs[#hargs + 1] = userId
end

local function callChunked(cmd, key, args, stride)
  local i = 1
  while i <= #args do
    local chunk = {}
    for j = i, math.min(i + (stride - 1), #args) do
      chunk[#chunk + 1] = args[j]
    end
    redis.call(cmd, key, unpack(chunk))
    i = i + stride
  end
end

callChunked('ZADD', seatsKey, zargs, 1000)
callChunked('HSET', ownerKey, hargs, 1000)
callChunked('ZADD', userKey, zargs, 1000)

-- Refreshed on every write. Safe because it always exceeds the longest hold this
-- call could have created, so it can never truncate a live hold; it only reclaims
-- keys for events that go quiet.
redis.call('EXPIRE', seatsKey, containerTtl)
redis.call('EXPIRE', ownerKey, containerTtl)
redis.call('EXPIRE', userKey, containerTtl)

return cjson.encode({ status = 'CLAIMED', expiresAt = tostring(math.floor(expiresAt)) })
`;

// Ownership is verified inside the script, not by the caller. A check-then-delete
// split would let a hold expire and be re-claimed by another user between the two
// steps, and the release would then free the new owner's seat.
const RELEASE_LUA = `
${LUA_PURGE_HELPERS}
${REDIS_TIME_LUA}

local seatsKey = KEYS[1]
local ownerKey = KEYS[2]
local userKey  = KEYS[3]

local userId = ARGV[1]

local tickets = {}
for i = 2, #ARGV do
  tickets[#tickets + 1] = ARGV[i]
end

purgeExpired(seatsKey, ownerKey, nowMs)
redis.call('ZREMRANGEBYSCORE', userKey, '-inf', '(' .. nowMs)

local ours, foreign, missing = {}, {}, {}
for _, ticketId in ipairs(tickets) do
  local owner = redis.call('HGET', ownerKey, ticketId)
  if owner == false then
    missing[#missing + 1] = ticketId
  elseif owner == userId then
    ours[#ours + 1] = ticketId
  else
    foreign[#foreign + 1] = ticketId
  end
end

-- All-or-nothing, matching reserve. A release that partially succeeded would
-- leave the caller holding an unrecognisable subset of what they asked to free.
if #foreign > 0 then
  return cjson.encode({ status = 'NOT_OWNER' })
end

if #ours == 0 then
  return cjson.encode({ status = 'NOT_FOUND' })
end

removeChunked('ZREM', seatsKey, ours)
removeChunked('HDEL', ownerKey, ours)
removeChunked('ZREM', userKey, ours)

return cjson.encode({ status = 'RELEASED', released = #ours, missing = #missing })
`;

const runScript = async (script, { eventId, userId, args }) => {
    const raw = await redis.eval(script, {
        keys: holdKeys(eventId, userId),
        arguments: args.map(String),
    });
    return JSON.parse(raw);
};

export const claimHold = async ({ eventId, userId, ticketIds, ttlSeconds, cap, confirmedCount }) =>
    runScript(RESERVE_LUA, {
        eventId,
        userId,
        args: [
            userId,
            ttlSeconds,
            cap,
            confirmedCount,
            HOLD_CONTAINER_TTL_SECONDS,
            ...ticketIds,
        ],
    });

export const releaseHold = async ({ eventId, userId, ticketIds }) =>
    runScript(RELEASE_LUA, { eventId, userId, args: [userId, ...ticketIds] });

// Read-only, used by the acceptance tests and by Week 2 Day 2's seat map. One
// round trip for the whole event regardless of seat count — the ZSET exists for
// exactly this. Scores are filtered by `now` here rather than trusting a purge
// to have run.
export const getLiveHolds = async (eventId) => {
    const [seats, owners] = await Promise.all([
        redis.zRangeByScoreWithScores(holdSeatsKey(eventId), Date.now(), "+inf"),
        redis.hGetAll(holdOwnerKey(eventId)),
    ]);

    return seats.map(({ value, score }) => ({
        ticketId: value,
        userId: owners[value] ?? null,
        expiresAt: new Date(score).toISOString(),
    }));
};
