import { createApiError } from "../utils/apiError.js";

// Hand-rolled because `booking` has no joi dependency. Runs entirely before any
// db work — per REQUIREMENTS.md, try/catch around a query is not validation.
const ID_PATTERN = /^\d+$/;

// Bigserial ids stay strings so values past Number.MAX_SAFE_INTEGER survive.
const isId = (value) => typeof value === "string" && ID_PATTERN.test(value) && value.length <= 19;

const MAX_TICKETS_PER_REQUEST = 20;

// Shared by confirm and reserve: both take exactly {eventId, ticketIds} and both
// must reject server-derived fields. Kept as one function so the two paths cannot
// drift into accepting different shapes for the same selection.
const validateTicketSelection = (body) => {
    const errors = [];

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw createApiError("body must be a JSON object", 422);
    }

    const { eventId, ticketIds } = body;

    if (!isId(eventId)) {
        errors.push("eventId must be a positive integer string");
    }

    if (!Array.isArray(ticketIds)) {
        errors.push("ticketIds must be an array");
    } else if (ticketIds.length === 0) {
        errors.push("ticketIds must contain at least one ticket");
    } else if (ticketIds.length > MAX_TICKETS_PER_REQUEST) {
        errors.push(`ticketIds must contain at most ${MAX_TICKETS_PER_REQUEST} tickets`);
    } else if (!ticketIds.every(isId)) {
        errors.push("every ticketId must be a positive integer string");
    } else if (new Set(ticketIds).size !== ticketIds.length) {
        // Left in, a repeat would make the rowcount guard's expected count wrong
        // and would hit UNIQUE(ticket_id) against the caller's own booking.
        errors.push("ticketIds must not contain duplicates");
    }

    // Invariant 7: the client never supplies a price, an amount, or an identity.
    // These are rejected rather than ignored so a client sending them learns why.
    for (const forbidden of ["price", "amount", "totalAmount", "userId", "status"]) {
        if (forbidden in body) {
            errors.push(`${forbidden} is server-derived and must not be sent`);
        }
    }

    if (errors.length > 0) {
        throw createApiError(errors.join(", "), 422);
    }

    return { eventId, ticketIds };
};

export const validateConfirmBooking = validateTicketSelection;

// `expiresAt` is added to the forbidden list by the same rule as `price`: the
// hold's lifetime is server-set, and a client that could name it could set it to
// next year.
export const validateReserve = (body) => {
    if (body !== null && typeof body === "object" && !Array.isArray(body) && "expiresAt" in body) {
        throw createApiError("expiresAt is server-derived and must not be sent", 422);
    }
    return validateTicketSelection(body);
};

// Identity comes from the gateway, never the body. Week 4 replaces this header
// with the authenticated JWT subject; the service-side contract stays the same.
export const requireUserId = (req) => {
    const userId = req.get("x-user-id");
    if (!isId(userId)) {
        throw createApiError("missing or invalid x-user-id", 401);
    }
    return userId;
};
