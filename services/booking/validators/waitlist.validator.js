import { createApiError } from "../utils/apiError.js";

// Same shape as booking.validator's own id check. Path params are validated as
// strictly as bodies — a param reaches a `bigint[]` cast and a Lua ARGV just as
// directly, and Express does no coercion of its own.
const ID_PATTERN = /^\d+$/;
const isId = (value) => typeof value === "string" && ID_PATTERN.test(value) && value.length <= 19;

export const validateEventIdParam = ({ eventId }) => {
    if (!isId(eventId)) {
        throw createApiError("eventId must be a positive integer", 422);
    }
    return { eventId };
};

export const validateBookingIdParam = ({ id }) => {
    if (!isId(id)) {
        throw createApiError("booking id must be a positive integer", 422);
    }
    return { bookingId: id };
};
