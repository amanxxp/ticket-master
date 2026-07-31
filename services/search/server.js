import "dotenv/config";
import app from "./app.js";

const PORT = Number(process.env.PORT) || 3003;

const startServer = async () => {
    try {
        // Week 3 Day 3 adds the Elasticsearch client and a ping here. Deliberately
        // not a startup dependency: this service must come up with ES down, serve
        // 503 on search, and recover on its own — search staleness is acceptable,
        // a service that refuses to boot is not.
        const server = app.listen(PORT, () => {
            console.log(`Search service listening on port ${PORT}`);
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
