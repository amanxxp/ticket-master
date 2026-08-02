import { createApiError } from "../utils/apiError.js";

// Hand-rolled — no joi dependency in this service. Runs before any ES call, so
// a malformed query never reaches the query-builder.
const MAX_SIZE = 100;
const DEFAULT_SIZE = 20;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// `type` has no backing field anywhere in the domain model — events carry no
// category/type column (see db/schema.sql). Accepted here so a client sending
// it doesn't 422, but it is not applied as a filter; see search.service.js and
// DECISIONS.md for why faking a filter against a field that doesn't exist would
// be worse than an honest no-op.
export const validateSearchQuery = (query) => {
    const errors = [];
    const { term, location, type, date, size } = query;

    if (term !== undefined && typeof term !== "string") {
        errors.push("term must be a string");
    }
    if (location !== undefined && typeof location !== "string") {
        errors.push("location must be a string");
    }
    if (type !== undefined && typeof type !== "string") {
        errors.push("type must be a string");
    }
    if (date !== undefined && (typeof date !== "string" || !DATE_PATTERN.test(date))) {
        errors.push("date must be an ISO calendar date (YYYY-MM-DD)");
    }

    let parsedSize = DEFAULT_SIZE;
    if (size !== undefined) {
        const n = Number(size);
        if (!Number.isInteger(n) || n < 1) {
            errors.push("size must be a positive integer");
        } else {
            // Clamped, not rejected — same resource-exhaustion reasoning as
            // GET /events' `limit`: an oversized request gets the max page,
            // not a 422 to retry with a smaller number.
            parsedSize = Math.min(n, MAX_SIZE);
        }
    }

    if (errors.length > 0) {
        throw createApiError(errors.join(", "), 422);
    }

    return {
        term: term ?? "",
        location: location || undefined,
        type: type || undefined,
        date: date || undefined,
        size: parsedSize,
    };
};
