import { createApiError } from "../utils/apiError.js";

const ID_PATTERN = /^\d+$/;
const isId = (value) => typeof value === "string" && ID_PATTERN.test(value) && value.length <= 19;

export const validateJoinQueue = (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw createApiError("body must be a JSON object", 422);
    }
    const { eventId } = body;
    if (!isId(eventId)) {
        throw createApiError("eventId must be a positive integer string", 422);
    }
    return { eventId };
};

export const validatePositionQuery = (query) => {
    const { eventId } = query;
    if (!isId(eventId)) {
        throw createApiError("eventId must be a positive integer string", 422);
    }
    return { eventId };
};
