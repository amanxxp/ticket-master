import * as seatmapService from "../services/seatmap.service.js";
import { optionalViewerId } from "../utils/viewer.js";
import * as registry from "../sse/registry.js";

// No buffering, no timeout (REQUIREMENTS.md routing table) — both handled here,
// not by proxying middleware, so this route works standalone before Week 4's
// gateway exists. Heartbeat exists for the same reason a hanging idle
// connection would otherwise get killed by an intermediary or by the client's
// own read timeout; it carries no availability data, just keeps the byte stream
// moving.
const HEARTBEAT_MS = 15000;

export const streamEvent = async (req, res) => {
    const { id: eventId } = req.validatedParams;
    const viewerUserId = optionalViewerId(req);

    // Validates the event exists and builds the initial frame before any SSE
    // header is sent — a 404 here still behaves like a normal JSON error
    // response instead of a stream that opens then immediately closes.
    const snapshot = await seatmapService.getSeatMap(eventId, viewerUserId);

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    registry.writeEvent(res, "snapshot", snapshot);

    const client = registry.addClient(eventId, res, viewerUserId);

    const heartbeat = setInterval(() => {
        res.write(": heartbeat\n\n");
    }, HEARTBEAT_MS);

    const cleanup = () => {
        clearInterval(heartbeat);
        registry.removeClient(eventId, client);
    };

    req.on("close", cleanup);
    res.on("error", cleanup);
};
