import redis from "../config/redis.js";

const LEADER_KEY = "admitter:leader";

// Fenced by instance id, not a bare `SET NX`: a bare NX would let the CURRENT
// leader's own renewal fail once it has set the key (NX only succeeds when the
// key is absent), which would force a re-election every tick even while
// perfectly healthy. Allowing the write when the key is either absent OR
// already held by this exact instance is what makes "acquire" and "renew" the
// same call — a different instance's attempt only ever succeeds once the
// current holder's key has actually expired (or been explicitly released).
// This is the whole mechanism behind "two admitter processes running -> still
// no over-admission": at any instant, at most one instance's tick can pass
// this check and go on to touch the queue.
const ACQUIRE_OR_RENEW_LUA = `
local current = redis.call('GET', KEYS[1])
if current == false or current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0
`;

// Deletes only if this instance is still the recorded holder — a plain DEL
// would risk deleting a NEWER leader's key if this instance's own lease had
// already expired (and someone else took over) before shutdown got to run.
// The fencing check is what makes SIGTERM-triggered release safe to do
// unconditionally on every shutdown, without first checking "am I even still
// the leader" as a separate round trip.
const RELEASE_LUA = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

// Same call serves both acquisition and renewal — the caller doesn't need to
// know or track which case it is; the answer is just "am I the leader for the
// next `leaseMs`, right now."
export const acquireOrRenewLease = async (instanceId, leaseMs) => {
    const result = await redis.eval(ACQUIRE_OR_RENEW_LUA, {
        keys: [LEADER_KEY],
        arguments: [instanceId, String(leaseMs)],
    });
    return result === 1;
};

// Called on SIGTERM so a restart resumes leadership immediately instead of
// waiting out the full lease TTL — the acceptance criterion this exists for.
export const releaseLease = async (instanceId) => {
    await redis.eval(RELEASE_LUA, {
        keys: [LEADER_KEY],
        arguments: [instanceId],
    });
};
