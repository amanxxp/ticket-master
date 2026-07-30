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

export const listEventsQuerySchema = Joi.object({
    // Keyset cursor is composite because event_date is not unique — a date alone
    // cannot say which of several same-day events the last page ended on.
    cursorDate: Joi.date().iso(),
    cursorId: id("cursorId"),
    pageSize: Joi.number().integer().min(1).max(100).default(10),
    venueId: id("venueId"),
    performerId: id("performerId"),
    upcoming: Joi.boolean().default(true)
}).and("cursorDate", "cursorId").messages({
    "object.and": "cursorDate and cursorId must be supplied together"
});
