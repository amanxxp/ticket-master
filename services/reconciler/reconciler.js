import "dotenv/config";
import pool, { connectDB } from "./config/db.js";
import { connectRedis, disconnectRedis } from "./config/redis.js";
import { runOnce } from "./services/reconciler.service.js";

import { numberFromEnv } from "./utils/env.js";

const TICK_MS = numberFromEnv("RECONCILER_TICK_MS", 30000);
const ONCE = process.argv.includes("--once");

// No leader lease, unlike the admitter — and that is a deliberate difference, not
// an omission. Every claim this worker makes uses FOR UPDATE SKIP LOCKED, so two
// instances sweeping at once simply take disjoint rows; there is no shared budget
// to overspend the way admission has. Safe to run concurrently, and safe to run
// twice over the same data, because every write is a guarded state transition.
const main = async () => {
    await connectDB();
    await connectRedis();

    if (ONCE) {
        await runOnce();
        await Promise.allSettled([pool.end(), disconnectRedis()]);
        return;
    }

    console.log(`reconciler: running, tick=${TICK_MS}ms`);
    let stopping = false;
    let inFlight = null;

    const loop = async () => {
        while (!stopping) {
            inFlight = runOnce().catch((err) => console.error("reconciler: tick failed:", err.message));
            await inFlight;
            inFlight = null;
            if (stopping) break;
            await new Promise((r) => setTimeout(r, TICK_MS));
        }
    };

    const shutdown = async (signal) => {
        console.log(`${signal} received, finishing current sweep`);
        stopping = true;
        // Waits for the sweep in progress rather than killing it mid-transaction —
        // an interrupted sweep would roll back cleanly, but finishing means the
        // next start has less to redo.
        if (inFlight) await inFlight.catch(() => {});
        await Promise.allSettled([pool.end(), disconnectRedis()]);
        process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    await loop();
};

main().catch((err) => { console.error("reconciler: fatal:", err); process.exit(1); });
