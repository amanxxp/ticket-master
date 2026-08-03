import { createClient } from "redis";

const client = createClient({
    socket: {
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
    },
});

// Must not throw or exit — a rate-limit check finding Redis down should fail
// that one request path (see rateLimit.js's fail-open), not the gateway
// process every other route depends on.
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
