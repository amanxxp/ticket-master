import "dotenv/config";
import app from "./app.js";
import { ensureSearchIndex } from "./config/elasticsearch.js";

const PORT = Number(process.env.PORT) || 3003;

const startServer = async () => {
    try {
        // Best-effort, not awaited-to-fail: a listen() that depended on this
        // would contradict the service's own contract of booting with ES down
        // and recovering on its own. If ES is up, the index is ready before the
        // first request; if not, ensureSearchIndex is retried by the poller and
        // by later restarts — a search request against a missing index is a
        // clean ES 404 the service already maps to its own error shape.
        ensureSearchIndex().catch((err) =>
            console.error("Could not ensure search index (will retry lazily):", err.message)
        );

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
