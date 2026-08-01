import redis from "../config/redis.js";
import { AVAILABILITY_CHANNEL_PATTERN, parseAvailabilityChannel } from "../../../shared/availability.js";
import { getTicketDeltas, toSeatStatus } from "../services/seatmap.service.js";
import * as registry from "./registry.js";

// SUBSCRIBE (and PSUBSCRIBE) put a connection into a mode where it can no
// longer run ordinary commands — a dedicated duplicate keeps the main `redis`
// export free for the plain reads seatmap.service.js issues. `duplicate()`
// carries the parent's socket options, so this connection gets the same
// reconnectStrategy/backoff for free.
let subscriber = null;

const handleMessage = async (message, channel) => {
    const eventId = parseAvailabilityChannel(channel);
    // Nothing local is watching this event — skip the Postgres/Redis round trip
    // a snapshot-of-changed-tickets would otherwise cost for no reader.
    if (!eventId || !registry.hasClients(eventId)) return;

    let payload;
    try {
        payload = JSON.parse(message);
    } catch {
        console.error(`Malformed availability message on ${channel}:`, message);
        return;
    }

    const ticketIds = Array.isArray(payload.ticketIds) ? payload.ticketIds : [];
    if (ticketIds.length === 0) return;

    try {
        const { tickets, holds } = await getTicketDeltas(eventId, ticketIds);
        registry.broadcast(eventId, (viewerUserId) => ({
            changeType: payload.type ?? "unknown",
            seats: tickets.map((ticket) => toSeatStatus(ticket, holds, viewerUserId)),
        }));
    } catch (err) {
        // A dropped update self-heals: reconnect calls getSeatMap for a fresh
        // full snapshot, so failing to push one delta cannot leave a client
        // permanently wrong, only briefly stale.
        console.error(`Failed to process availability update for event ${eventId}:`, err.message);
    }
};

export const startAvailabilitySubscriber = async () => {
    if (subscriber) return;

    subscriber = redis.duplicate();
    // Must not throw or exit — reconnection is the client's own job (invariant
    // 2's "Redis loss is survivable" extended to the stream: a dead subscriber
    // should reconnect on its own, not take the process down with it).
    subscriber.on("error", (err) => console.error("Availability subscriber error:", err.message));

    await subscriber.connect();
    await subscriber.pSubscribe(AVAILABILITY_CHANNEL_PATTERN, handleMessage);
    console.log("Subscribed to availability updates");
};

export const stopAvailabilitySubscriber = async () => {
    if (subscriber?.isOpen) {
        await subscriber.quit();
    }
    subscriber = null;
};
