import { createApiError } from "./apiError.js";

// `DELETE /bookings/reserve/:id` needs an id, but a hold is Redis state with a
// TTL — persisting a server-side id→hold mapping would add a second thing that
// can outlive the hold it names. So the id is derived: base64url of the event and
// ticket ids it refers to.
//
// Unsigned on purpose. The id is a locator, not a capability: release re-checks
// ownership against the owner hash inside the Lua script, so forging an id for
// someone else's seats yields a 404. Signing would protect a secret the id does
// not carry.
const encode = (value) => Buffer.from(value, "utf8").toString("base64url");

export const encodeHoldId = (eventId, ticketIds) =>
    encode(JSON.stringify({ e: eventId, t: ticketIds }));

const ID_PATTERN = /^\d+$/;
const isId = (value) => typeof value === "string" && ID_PATTERN.test(value) && value.length <= 19;

export const decodeHoldId = (holdId) => {
    const invalid = () => createApiError("malformed holdId", 400);

    if (typeof holdId !== "string" || holdId.length === 0 || holdId.length > 512) {
        throw invalid();
    }

    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(holdId, "base64url").toString("utf8"));
    } catch {
        throw invalid();
    }

    // Re-validated as strictly as a request body would be. A decoded id is
    // attacker-controlled input, and it reaches Lua ARGV and a bigint[] cast.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw invalid();
    }

    const { e: eventId, t: ticketIds } = parsed;

    if (!isId(eventId)) throw invalid();
    if (!Array.isArray(ticketIds) || ticketIds.length === 0 || ticketIds.length > 20) {
        throw invalid();
    }
    if (!ticketIds.every(isId)) throw invalid();
    if (new Set(ticketIds).size !== ticketIds.length) throw invalid();

    return { eventId, ticketIds };
};
