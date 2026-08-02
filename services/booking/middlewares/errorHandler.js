import { codeForStatus } from "../../../shared/httpError.js";

export const errorHandler = (err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }

    const status = err.isApiError ? err.status : 500;
    const message = err.isApiError ? err.message : "Internal server error";

    if (!err.isApiError) {
        console.error(`[${req.correlationId}]`, err);
    }

    res.status(status).json({
        error: {
            code: codeForStatus(status),
            message,
            correlationId: req.correlationId,
        },
    });
};
