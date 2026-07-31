// Hold-key naming and expiry semantics, shared by Booking Service (the only
// writer) and Event Service (a reader). Two implementations of these names would
// drift, and drift here renders a held seat as available — REQUIREMENTS.md
// "Hold-state ownership rule".
//
// Three structures per event, not one, because the claim and the bulk read want
// opposite things:
//
//   <tag>:seats  ZSET  member=ticketId  score=expiresAtMs
//       The read path. One ZRANGEBYSCORE returns every live hold for the event,
//       so the seat map costs the same round trips at 50 tickets and 50,000
//       (invariant 3). A per-ticket-key design cannot do this — it would need
//       one GET per seat.
//
//   <tag>:owner  HASH  field=ticketId  value=userId
//       Ownership lookup: who holds this seat, for conflict detection and for
//       verifying a release. Kept beside the ZSET rather than encoded into its
//       member so the score stays a pure number.
//
//   <tag>:u:<userId>  ZSET  member=ticketId  score=expiresAtMs
//       Per-user index. Makes "how many does this user already hold" a ZCARD
//       instead of a scan of the whole event, which is what lets the per-user
//       cap be checked inside the same atomic script as the claim.
//
// All three share the hash tag `{evt:<eventId>}` so one Lua script can touch
// them together — Redis requires every key in a script to live on one slot, and
// colocating an event's keys is what sharding would want regardless.
//
// Expiry is carried by the ZSET score, NOT by a per-key Redis TTL. Consequences,
// both deliberate:
//   · A hold is ineffective the instant its score passes now, whether or not
//     anything has reclaimed the memory. No sweeper is a correctness dependency.
//   · Readers filter by score, so an expired hold can never be observed as live
//     — the gap a keyspace-notification design leaves open does not exist here.
// Memory is reclaimed lazily (see purge in hold.repository.js) plus a coarse TTL
// on the container keys, refreshed on every write, so a quiet event's keys fall
// away on their own.

export const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS) || 600;

// Outlives any hold written during the window, so refreshing it on write can
// never truncate a live hold. Only reclaims keys for events nobody touches.
export const HOLD_CONTAINER_TTL_SECONDS = HOLD_TTL_SECONDS + 300;

const eventTag = (eventId) => `hold:{evt:${eventId}}`;

export const holdSeatsKey = (eventId) => `${eventTag(eventId)}:seats`;
export const holdOwnerKey = (eventId) => `${eventTag(eventId)}:owner`;
export const holdUserKey = (eventId, userId) => `${eventTag(eventId)}:u:${userId}`;

// Every key a single event's scripts may touch, in the order the Lua expects.
export const holdKeys = (eventId, userId) => [
    holdSeatsKey(eventId),
    holdOwnerKey(eventId),
    holdUserKey(eventId, userId),
];

// Redis' clock is the only authority on whether a hold has expired — resolves
// the open "clock authority" item in DECISIONS.md. Two app instances with skewed
// clocks would otherwise disagree about the same hold, and the loser of that
// disagreement either resells a held seat or refuses a free one. `redis.call
// ('TIME')` inside the script means the comparison and the write share one
// clock reading, so app clocks are never compared to anything.
export const REDIS_TIME_LUA = `
local t = redis.call('TIME')
local nowMs = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)
`;

// ZREM/HDEL take variadic members; unpack() on a large table overflows the Lua
// stack, so removal is chunked. Shared because both the reserve and release
// scripts purge before they decide anything.
export const LUA_PURGE_HELPERS = `
local function removeChunked(cmd, key, members)
  local i = 1
  while i <= #members do
    local chunk = {}
    for j = i, math.min(i + 499, #members) do
      chunk[#chunk + 1] = members[j]
    end
    redis.call(cmd, key, unpack(chunk))
    i = i + 500
  end
end

-- Lazy purge. Reclaims memory only; correctness already comes from the score
-- filter, so a purge that never runs cannot resell a seat.
local function purgeExpired(seatsKey, ownerKey, nowMs)
  local expired = redis.call('ZRANGEBYSCORE', seatsKey, '-inf', '(' .. nowMs)
  if #expired > 0 then
    removeChunked('ZREM', seatsKey, expired)
    removeChunked('HDEL', ownerKey, expired)
  end
  return expired
end
`;
