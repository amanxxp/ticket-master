// Maps the status codes REQUIREMENTS.md's cross-cutting section names to a
// stable machine-readable code, for the `error.code` field of the shared error
// shape. Shared so every service's errorHandler.js picks the same string for
// the same status — "identical everywhere" applies to the code, not only the
// envelope shape around it.
const STATUS_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHENTICATED",
    403: "UNAUTHORIZED",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    503: "SERVICE_UNAVAILABLE",
};

export const codeForStatus = (status) => STATUS_CODES[status] ?? "INTERNAL_ERROR";
