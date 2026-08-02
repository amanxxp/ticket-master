import { randomUUID } from "node:crypto";

// One header name, agreed everywhere, so the gateway's id and every downstream
// service's reading of it can never drift onto two different header strings —
// same reasoning as the Redis key naming and the ES index contract elsewhere
// in shared/.
export const CORRELATION_ID_HEADER = "x-correlation-id";

const MAX_LEN = 200;

// Reused by the gateway (generate, or accept one a trusted client already
// supplied) and by every downstream service (read whatever the gateway
// forwarded; generate a fallback if something reached this service directly,
// bypassing the gateway — a dev request, a test, a misconfigured client).
// Same function either way: "use it if it looks like a real id, else make one."
export const getOrCreateCorrelationId = (req) => {
    const incoming = typeof req.get === "function"
        ? req.get(CORRELATION_ID_HEADER)
        : req.headers?.[CORRELATION_ID_HEADER];

    if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= MAX_LEN) {
        return incoming;
    }
    return randomUUID();
};
