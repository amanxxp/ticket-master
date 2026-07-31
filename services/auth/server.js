import "dotenv/config";
import app from "./app.js";

const PORT = Number(process.env.PORT) || 3001;

const startServer = async () => {
    try {
        // Week 4 Day 2 adds `await connectDB()` here, plus `pool.end()` in the
        // shutdown handler. Until then this service has no datastore to drain.
        const server = app.listen(PORT, () => {
            console.log(`Auth service listening on port ${PORT}`);
        });

        const shutdown = (signal) => {
            console.log(`${signal} received, shutting down`);
            server.close(() => process.exit(0));
        };

        process.on("SIGINT", () => shutdown("SIGINT"));
        process.on("SIGTERM", () => shutdown("SIGTERM"));
    } catch (error) {
        console.error("error while starting server:", error);
        process.exit(1);
    }
}

startServer();
