import Joi from "joi";

// seat_map is structural only (sections/rows/capacity) — availability lives in `tickets`.
const seatMapSchema = Joi.object({
    sections: Joi.array().items(
        Joi.object({
            name: Joi.string().min(1).max(64).required(),
            rows: Joi.array().items(
                Joi.object({
                    label: Joi.string().min(1).max(16).required(),
                    seats: Joi.number().integer().min(1).max(10000).required()
                })
            ).min(1).required()
        })
    ).min(1).required()
});

export const createVenueSchema = Joi.object({
    name: Joi.string().trim().min(2).max(200).required(),
    location: Joi.string().trim().min(2).max(500).required(),
    seatMap: seatMapSchema.required()
});

// seat_map replaces wholesale — a partial merge would silently orphan tickets
// that reference sections/rows the new map no longer defines.
export const updateVenueSchema = Joi.object({
    name: Joi.string().trim().min(2).max(200),
    location: Joi.string().trim().min(2).max(500),
    seatMap: seatMapSchema
}).min(1).messages({
    "object.min": "At least one of name, location or seatMap must be provided"
});

// Ids are bigserial — kept as strings so values past Number.MAX_SAFE_INTEGER
// survive the round trip intact (pg accepts strings for bigint params).
const idSchema = Joi.string().pattern(/^\d+$/).max(19).required().messages({
    "string.pattern.base": "id must be a positive integer"
});

export const venueIdParamSchema = Joi.object({
    id: idSchema
});

export const listVenuesQuerySchema = Joi.object({
    cursor: Joi.string().pattern(/^\d+$/).max(19).default("0").messages({
        "string.pattern.base": "cursor must be a positive integer"
    }),
    pageSize: Joi.number().integer().min(1).max(100).default(10)
});
