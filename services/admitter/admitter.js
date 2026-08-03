import "dotenv/config";
import { randomUUID } from "node:crypto";
import pool, { connectDB } from "./config/db.js";
import { connectRedis, disconnectRedis } from "./config/redis.js";
import { acquireOrRenewLease, releaseLease } from "./repositories/leader.repository.js";
import { getActiveEventIds } from "./repositories/queue.repository.js";
import { drainEvent } from "./services/admitter.service.js";

const INSTANCE_ID = randomUUID();
const LEASE_MS = Number(process.env.ADMITTER_LEASE_MS) || 10000;
const TICK_MS = Number(process.env.ADMITTER_TICK_MS) || 2000;

// One tick: try to hold (or renew) leadership, and if successful, drain every
// event with a non-empty waiting queue. A losing instance does nothing this
// tick and simply tries again next tick — it never touches the queue, which
// is the entire mechanism behind "two admitter processes running -> still no
// over-admission": at most one instance's `admitBatch` call can ever be in
// flight for a given event at a given moment, because only the fenced leader
// reaches that call at all.
export const tick = async () => {
    const isLeader = await acquireOrRenewLease(INSTANCE_ID, LEASE_MS);
    if (!isLeader) {
        return { isLeader: false, results: [] };
    }

    const eventIds = await getActiveEventIds();
    const results = [];
    for (const eventId of eventIds) {
        try {
            results.push(await drainEvent(eventId));
        } catch (err) {
            // One event's failure (a bad Postgres read, a malformed queue
            // entry) must not stop the leader from draining every other
            // event this tick — same "don't let one bad row poison the
            // batch" reasoning as the outbox poller.
            console.error(`admitter: failed to drain event ${eventId}:`, err.message);
        }
    }
    return { isLeader: true, results };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runLoop = async () => {
    try {
        await connectDB();
    } catch (error) {
        console.error("admitter: could not connect to Postgres:", error.message);
        process.exit(1);
    }

    try {
        await connectRedis();
    } catch (error) {
        // Unlike the outbox poller's relationship with Elasticsearch, Redis is
        // not optional here — every tick's leadership check and every queue
        // read/write goes through it. A Redis this process cannot reach at
        // all leaves nothing useful to do.
        console.error("admitter: could not connect to Redis:", error.message);
        process.exit(1);
    }

    console.log(`admitter: running, instance=${INSTANCE_ID}, lease=${LEASE_MS}ms, tick=${TICK_MS}ms`);

    let stopping = false;
    const shutdown = async (signal) => {
        console.log(`${signal} received, releasing lease and exiting`);
        stopping = true;
        // Released unconditionally — the fencing check inside releaseLease
        // itself is what makes this safe even if this instance's lease had
        // already expired and someone else became leader before this ran.
        // This is the acceptance criterion: without it, a restarted instance
        // would sit idle for up to LEASE_MS waiting for the dead instance's
        // lease to expire on its own.
        await releaseLease(INSTANCE_ID).catch((err) =>
            console.error("admitter: failed to release lease on shutdown:", err.message)
        );
        await Promise.allSettled([pool.end(), disconnectRedis()]);
        process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    while (!stopping) {
        await tick().catch((err) => console.error("admitter: unexpected error in tick", err));
        await sleep(TICK_MS);
    }
};

// Only run the loop when this file is executed directly — importing `tick`
// for a test must not also start the infinite loop or open real connections.
if (import.meta.url === `file://${process.argv[1]}`) {
    runLoop();
}
