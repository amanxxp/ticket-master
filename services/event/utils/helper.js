import { createApiError } from "./apiError.js";

// Postgres error codes worth surfacing to the client instead of a generic 500.
const PG_ERROR_STATUS = {
    '23505': 409, // unique_violation
    '23503': 400, // foreign_key_violation
    '23514': 400, // check_violation
};

export const rethrowPgError = (error, action, entity = "record") => {
    const status = PG_ERROR_STATUS[error.code];
    if (status) {
        throw createApiError(`Could not ${action} ${entity}: ${error.detail ?? error.message}`, status);
    }
    console.error(`Error during ${entity} ${action}`, error);
    throw error;
};
