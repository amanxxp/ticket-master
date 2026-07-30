import { createApiError } from "../utils/apiError.js";

// Express 5 exposes req.query as a getter-only property, so validated query
// values are written to req.validatedQuery instead of mutating req.query.
const TARGETS = {
    body: { read: (req) => req.body, write: (req, value) => { req.body = value; } },
    params: { read: (req) => req.params, write: (req, value) => { req.validatedParams = value; } },
    query: { read: (req) => req.query, write: (req, value) => { req.validatedQuery = value; } },
};

export const validate = (schema, source = "body") => (req, res, next) => {
    const target = TARGETS[source];
    if (!target) {
        throw createApiError(`Unknown validation source: ${source}`, 500);
    }

    const { error, value } = schema.validate(target.read(req), {
        abortEarly: false,
        stripUnknown: true
    });

    if (error) {
        throw createApiError(error.details.map((d) => d.message).join(", "), 422);
    }

    target.write(req, value);

    next();
}
