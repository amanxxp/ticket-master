import "dotenv/config";
import app from "./app.js";
import pool, { connectDB } from "./config/db.js";
import { connectRedis, disconnectRedis } from "./config/redis.js";
import { startAvailabilitySubscriber, stopAvailabilitySubscriber } from "./sse/subscriber.js";

const PORT = Number(process.env.PORT) || 3002;

const startServer = async () => {
    try {
        await connectDB();
        await connectRedis();
        // Started here, not at module load: importing app.js (as tests do) must
        // not open a real Redis subscription as a side effect.
        await startAvailabilitySubscriber();

        const server = app.listen(PORT, () => {
            console.log(`Event service listening on port ${PORT}`);
        });

        // Stop accepting connections, then drain both stores, before exiting.
        const shutdown = (signal) => {
            console.log(`${signal} received, shutting down`);
            server.close(async () => {
                await Promise.allSettled([stopAvailabilitySubscriber(), pool.end(), disconnectRedis()]);
                process.exit(0);
            });
        };

        process.on("SIGINT", () => shutdown("SIGINT"));
        process.on("SIGTERM", () => shutdown("SIGTERM"));
    } catch (error) {
        console.error("error while starting server:", error);
        process.exit(1);
    }
}

startServer();
