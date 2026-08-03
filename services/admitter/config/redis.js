import { createClient } from "redis";

const client = createClient({
    socket: {
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
    },
});

// Must not throw or exit — losing Redis mid-tick should fail that tick (the
// leader lease simply isn't renewed, so another instance takes over once it
// expires), not crash the process.
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
