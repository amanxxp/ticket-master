import { createApiError } from "./apiError.js";

// The keyset cursor must be composite — (event_date, id) — because event_date
// alone is not unique: several events on the same day share a score, and a
// cursor holding only the date cannot say which of them the last page ended on.
// A bare-id cursor is wrong for a different reason: the list is sorted by
// event_date first, and id has no relationship to event_date (an event created
// later can have an earlier event_date than one created before it). Filtering
// `id > lastId` walks the *insertion* order, not the *display* order — it can
// both skip a row (later event_date, smaller id — never shown) and repeat one
// (earlier event_date, larger id — already shown, shown again). Only a filter
// on the actual sort key, tie-broken by id, tracks the real position:
// `(event_date, id) > (lastDate, lastId)`.
//
// Encoded as one opaque token rather than two query params (?cursorDate=&cursorId=)
// so the client carries one string, not two values it must keep paired — same
// "unsigned locator, not a capability" pattern as holdId.js. Unsigned because a
// forged cursor only ever produces a wrong *page*, never unauthorized data — the
// query still filters by is_deleted and the caller's own venue/performer/upcoming
// params regardless of what the cursor claims.
const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

export const encodeEventCursor = (eventDate, id) => encode({ d: eventDate, i: id });

const ID_PATTERN = /^\d+$/;
const isId = (value) => typeof value === "string" && ID_PATTERN.test(value) && value.length <= 19;

export const decodeEventCursor = (cursor) => {
    const invalid = () => createApiError("malformed cursor", 422);

    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 512) {
        throw invalid();
    }

    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
        throw invalid();
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw invalid();
    }

    const { d: eventDate, i: id } = parsed;
    if (typeof eventDate !== "string" || Number.isNaN(Date.parse(eventDate))) {
        throw invalid();
    }
    if (!isId(id)) {
        throw invalid();
    }

    return { eventDate, id };
};
