import redis from "../config/redis.js";
import { availabilityChannel } from "../../../shared/availability.js";

// PUBLISH is a normal command — no dedicated connection needed the way
// SUBSCRIBE requires on the Event Service side, so this reuses the same client
// hold.repository.js already runs EVAL on.
//
// Never throws. A reserve/release/confirm has already committed by the time
// this runs; failing to announce it degrades one thing only — how fast open
// SSE streams learn about the change. A client that missed the push still
// sees correct state on its next reconnect snapshot (same Postgres + Redis
// truth, no separate cache to go stale). Letting a publish failure fail the
// request it's reporting on would be a worse outage than the one it's trying
// to prevent.
// `correlationId` rides in the message body, not a Redis/pub-sub header — pub/sub
// has no header concept, so the only way this id crosses the HTTP→Redis boundary
// is by being part of the payload the subscriber reads. This is what makes
// "trace one request end-to-end using only that id" provable across the pub/sub
// hop specifically: grep the gateway's access log, booking's access log, and
// Event Service's subscriber log for the same id and see the same request's
// effect land in all three.
export const publishAvailabilityChange = async (eventId, type, ticketIds, correlationId) => {
    if (!ticketIds || ticketIds.length === 0) return;
    try {
        await redis.publish(availabilityChannel(eventId), JSON.stringify({ type, ticketIds, correlationId }));
    } catch (err) {
        console.error(`[${correlationId}] Failed to publish availability change for event ${eventId}:`, err.message);
    }
};
