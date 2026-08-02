import { codeForStatus } from "../../../shared/httpError.js";

export const errorHandler = (err, req, res, next) => {
    // Delegates to Express's default handler once headers are already sent —
    // matters specifically here because the proxy's own `on.error` handler
    // (routes/proxy.js) may already have written the response for this exact
    // request before this middleware ever runs.
    if (res.headersSent) {
        return next(err);
    }

    const status = err.isApiError ? err.status : 500;
    const message = err.isApiError ? err.message : "Internal server error";

    if (!err.isApiError) {
        console.error(`[${req.correlationId}]`, err);
    }

    if (err.retryAfter) {
        res.set("Retry-After", err.retryAfter);
    }

    res.status(status).json({
        error: {
            code: codeForStatus(status),
            message,
            correlationId: req.correlationId,
        },
    });
};
