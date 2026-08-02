import { getOrCreateCorrelationId, CORRELATION_ID_HEADER } from "../../../shared/correlationId.js";

// Runs before the proxy routes — the id has to exist before anything is
// forwarded downstream, logged, or (on error) returned to the caller.
export const correlationId = (req, res, next) => {
    req.correlationId = getOrCreateCorrelationId(req);
    res.setHeader(CORRELATION_ID_HEADER, req.correlationId);
    next();
};
