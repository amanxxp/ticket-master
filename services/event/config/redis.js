import { createClient } from "redis";

const client = createClient({
    socket: {
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
    },
});

// Emitted on every reconnect attempt too, so this must not throw or exit — the
// client retries on its own. A seatmap request that finds Redis down should fail
// that request, not the process.
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
