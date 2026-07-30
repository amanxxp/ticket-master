import Joi from "joi";

// Ids are bigserial — kept as strings so values past Number.MAX_SAFE_INTEGER
// survive the round trip intact (pg accepts strings for bigint params).
const id = (label) => Joi.string().pattern(/^\d+$/).max(19).messages({
    "string.pattern.base": `${label} must be a positive integer`
});

// NUMERIC(10, 2): 8 digits before the point, 2 after.
// Joi's own .precision(2) *rounds* by default — it would turn a submitted 10.555
// into 10.56 and report success. Money is not silently adjustable, so extra
// decimals are rejected instead. The round-trip comparison avoids the float
// artifact in `10.55 * 100 === 1055.0000000000001`.
const price = Joi.number().min(0).max(99999999.99).unsafe(false).custom((value, helpers) => {
    if (Math.round(value * 100) / 100 !== value) {
        return helpers.error("price.decimals");
    }
    return value;
}).messages({
    "price.decimals": "price must have at most 2 decimal places"
});

const seat = Joi.string().trim().min(1).max(64);

export const ticketIdParamSchema = Joi.object({
    eventId: id("eventId").required(),
    ticketId: id("ticketId").required()
});

export const eventIdParamSchema = Joi.object({
    eventId: id("eventId").required()
});

// Bulk insert is one statement, so the cap bounds both the payload and the
// number of array elements pushed into a single UNNEST.
export const createTicketsSchema = Joi.object({
    tickets: Joi.array().items(
        Joi.object({
            seat: seat.required(),
            price: price.required()
        })
    ).min(1).max(1000).unique("seat").required().messages({
        "array.unique": "duplicate seat in request payload"
    })
});

// Mints inventory from the venue's seat_map. Per-section prices; `defaultPrice`
// covers any section not named explicitly.
export const generateTicketsSchema = Joi.object({
    defaultPrice: price,
    // No .default([]) here: a default would satisfy the .or() below and let an
    // empty body through. expandSeatMap already treats absent pricing as [].
    pricing: Joi.array().items(
        Joi.object({
            section: Joi.string().trim().min(1).max(64).required(),
            price: price.required()
        })
    ).unique("section")
}).or("defaultPrice", "pricing").messages({
    "object.missing": "provide defaultPrice, pricing, or both"
});

// `status` is intentionally absent and explicitly rejected rather than silently
// stripped: available -> booked is the Booking Service confirm path's to make,
// and a quiet 200 here would look like it worked.
export const updateTicketSchema = Joi.object({
    price: price.required(),
    status: Joi.any().forbidden().messages({
        "any.unknown": "ticket status is owned by the Booking Service and cannot be set here"
    })
});

export const listTicketsQuerySchema = Joi.object({
    cursor: Joi.string().pattern(/^\d+$/).max(19).default("0").messages({
        "string.pattern.base": "cursor must be a positive integer"
    }),
    pageSize: Joi.number().integer().min(1).max(200).default(50),
    // Filters the stored column only. This is NOT effective availability — a
    // row reading 'available' here may be held in Redis right now.
    status: Joi.string().valid("available", "booked")
});
