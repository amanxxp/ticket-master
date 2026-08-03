import { createApiError } from "../utils/apiError.js";

export const validate = (schema) => (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true
    });

    if (error) {
        throw createApiError(error.details.map((d) => d.message).join(", "), 422);
    }

    req.body = value;

    next();
}
