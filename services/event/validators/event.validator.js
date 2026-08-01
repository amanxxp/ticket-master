import Joi from "joi";

// Ids are bigserial — kept as strings so values past Number.MAX_SAFE_INTEGER
// survive the round trip intact (pg accepts strings for bigint params).
const id = (label) => Joi.string().pattern(/^\d+$/).max(19).messages({
    "string.pattern.base": `${label} must be a positive integer`
});

export const eventIdParamSchema = Joi.object({
    id: id("id").required()
});

export const createEventSchema = Joi.object({
    name: Joi.string().trim().min(2).max(200).required(),
    description: Joi.string().trim().max(2000).allow("", null).default(null),
    venueId: id("venueId").required(),
    performerId: id("performerId").required(),
    eventDate: Joi.date().iso().greater("now").required().messages({
        "date.greater": "eventDate must be in the future"
    }),
    maxTicketsPerUser: Joi.number().integer().min(1).max(50).required()
});

// eventDate drops the `greater('now')` rule here: rescheduling an event that has
// already started is legitimate ops work, and blocking it would strand the row.
export const updateEventSchema = Joi.object({
    name: Joi.string().trim().min(2).max(200),
    description: Joi.string().trim().max(2000).allow("", null),
    venueId: id("venueId"),
    performerId: id("performerId"),
    eventDate: Joi.date().iso(),
    maxTicketsPerUser: Joi.number().integer().min(1).max(50)
}).min(1).messages({
    "object.min": "At least one field must be provided"
});

const MAX_LIMIT = 100;

export const listEventsQuerySchema = Joi.object({
    // Offset mode. Mutually exclusive with `cursor` — a request can't ask for
    // both a page number and a cursor position at once.
    page: Joi.number().integer().min(1),
    // Keyset mode: one opaque token encoding (event_date, id) — see
    // utils/eventCursor.js for why the cursor has to be composite.
    cursor: Joi.string().max(512),
    // Capped, not rejected: `limit=100000` clamps to 100 rather than 422ing,
    // per the resource-exhaustion requirement — a client asking for too much
    // gets the max page size, not an error to retry with a smaller number.
    limit: Joi.number().integer().min(1).default(10).custom((value) => Math.min(value, MAX_LIMIT)),
    venueId: id("venueId"),
    performerId: id("performerId"),
    upcoming: Joi.boolean().default(true)
}).nand("page", "cursor").messages({
    "object.nand": "page and cursor are mutually exclusive — choose one pagination mode"
});
