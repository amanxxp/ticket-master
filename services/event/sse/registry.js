// In-process only, per Event Service instance — deliberately not shared state.
// Day 3's "two instances" test is satisfied by Redis pub/sub delivering the same
// message to every instance, each of which then only has to fan out to its own
// locally-connected clients. This registry never needs to know about the other
// instance's clients.
const clientsByEvent = new Map();

let nextClientId = 1;

export const addClient = (eventId, res, viewerUserId) => {
    if (!clientsByEvent.has(eventId)) {
        clientsByEvent.set(eventId, new Set());
    }
    const client = { id: nextClientId++, res, viewerUserId };
    clientsByEvent.get(eventId).add(client);
    return client;
};

export const removeClient = (eventId, client) => {
    const set = clientsByEvent.get(eventId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) {
        clientsByEvent.delete(eventId);
    }
};

// Lets the subscriber skip a Postgres/Redis round trip for an event nobody is
// watching right now — a message can arrive for an event with zero local
// subscribers, and there is nothing useful to compute in that case.
export const hasClients = (eventId) => clientsByEvent.has(eventId);

export const clientCount = (eventId) => clientsByEvent.get(eventId)?.size ?? 0;

export const writeEvent = (res, event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
};

// buildPayload is called once per connected client, not once per event, because
// heldByMe depends on which viewer is looking — one incoming change can render
// differently for every open connection on the same event.
export const broadcast = (eventId, buildPayload) => {
    const set = clientsByEvent.get(eventId);
    if (!set || set.size === 0) return;
    for (const client of set) {
        writeEvent(client.res, "availability.update", buildPayload(client.viewerUserId));
    }
};
