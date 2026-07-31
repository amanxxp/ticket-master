import "dotenv/config";
import app from "./app.js";

const PORT = Number(process.env.PORT) || 3000;

const startServer = async () => {
    try {
        const server = app.listen(PORT, () => {
            console.log(`Gateway listening on port ${PORT}`);
        });

        // Longer than any upstream timeout the gateway sets, so an in-flight
        // proxied request finishes rather than being cut at the client's end.
        // Week 4 Day 1 sets those timeouts; this is the ceiling above them.
        server.headersTimeout = 65_000;
        server.requestTimeout = 0;

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
