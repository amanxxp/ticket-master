import { getOrCreateCorrelationId, CORRELATION_ID_HEADER } from "../../../shared/correlationId.js";

// Normally forwarded by the gateway; generates a fallback if this service is
// ever reached directly (a dev request, a test) so logs and error bodies never
// have to handle "no id" as a separate case.
export const correlationId = (req, res, next) => {
    req.correlationId = getOrCreateCorrelationId(req);
    res.setHeader(CORRELATION_ID_HEADER, req.correlationId);
    next();
};
