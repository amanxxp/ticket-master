import "dotenv/config";
import app from "./app.js";
import pool, { connectDB } from "./config/db.js";
import { connectRedis, disconnectRedis } from "./config/redis.js";

const PORT = Number(process.env.PORT) || 3004;

const startServer = async () => {
    try {
        await connectDB();
        await connectRedis();

        const server = app.listen(PORT, () => {
            console.log(`Booking service listening on port ${PORT}`);
        });

        // Stop accepting connections, then drain both stores, before exiting.
        const shutdown = (signal) => {
            console.log(`${signal} received, shutting down`);
            server.close(async () => {
                await Promise.allSettled([pool.end(), disconnectRedis()]);
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
