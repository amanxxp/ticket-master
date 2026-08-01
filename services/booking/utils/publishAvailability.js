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
export const publishAvailabilityChange = async (eventId, type, ticketIds) => {
    if (!ticketIds || ticketIds.length === 0) return;
    try {
        await redis.publish(availabilityChannel(eventId), JSON.stringify({ type, ticketIds }));
    } catch (err) {
        console.error(`Failed to publish availability change for event ${eventId}:`, err.message);
    }
};
