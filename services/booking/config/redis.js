import { createClient } from "redis";

const client = createClient({
    socket: {
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
        // Without a connect timeout the socket layer can sit indefinitely on an
        // unreachable host — a firewalled or black-holed Redis, rather than a
        // refused connection, never answers at all.
        connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 3000,
    },
    // The important one, found by the Week 6 Day 3 drill. node-redis's DEFAULT is
    // to queue commands while disconnected and replay them on reconnect. That
    // turns "Redis is down" into "every request that touches Redis hangs forever":
    // the command never rejects, the handler never returns, the HTTP request never
    // completes, and the client is left holding a connection until it gives up.
    // Enough of those and the service is unreachable even for routes that never
    // touch Redis — an outage in the cache becomes an outage in everything.
    //
    // With the offline queue disabled, a command issued while disconnected rejects
    // immediately. Reserve then fails fast with a clean 5xx, and confirm — which
    // needs only Postgres — keeps working. That is what invariant 2 ("Redis loss is
    // survivable") actually requires: fail fast, not queue quietly.
    disableOfflineQueue: true,
});

// Emitted on every reconnect attempt too, so this must not throw or exit — the
// client retries on its own. A hold path that finds Redis down should fail the
// request, not the process (invariant 2: Redis loss is survivable).
client.on("error", (err) => {
    console.error("Redis client error:", err.message);
});

export const connectRedis = async () => {
    await client.connect();
    await client.ping();
    console.log("Redis connected successfully");
};

export const disconnectRedis = async () => {
    if (client.isOpen) {
        await client.quit();
    }
};

export default client;
