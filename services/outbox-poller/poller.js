import "dotenv/config";
import pool, { connectDB } from "./config/db.js";
import esClient, { ensureSearchIndex } from "./config/elasticsearch.js";
import { claimBatch, markPublished } from "./repositories/outbox.repository.js";
import { applyToElasticsearch } from "./services/indexer.service.js";

const BATCH_SIZE = Number(process.env.OUTBOX_BATCH_SIZE) || 100;
const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 1000;

// One transaction per batch. Ordering inside it is the whole correctness
// argument for both required failure modes:
//
//   ES down (every row fails): nothing gets marked published, ROLLBACK/COMMIT
//   either way leaves every row exactly as unpublished as it started — the
//   original Postgres write already committed independently of this poller, so
//   "event write still succeeds" was never in question; only search staleness
//   follows, which is the acceptable failure named in the requirement.
//
//   Killed mid-batch (process dies before COMMIT): Postgres rolls back the
//   whole open transaction on connection loss, so no `published_at` UPDATE from
//   this batch took effect and every row's lock releases. The next poller
//   (this one restarted, or another instance) claims the same rows again and
//   re-applies them. Because the ES document id is deterministic (searchDocId),
//   re-indexing an already-indexed event is an overwrite, not a duplicate — "no
//   lost events, no duplicate documents" without any special crash-recovery
//   logic, just ordinary transactional semantics plus an idempotent write.
//
// Each row is applied and marked individually within the one open transaction,
// not batched into one final UPDATE — so a single malformed row failing does
// not also roll back the rows around it that succeeded; only the failed row is
// left for the next tick to retry.
export const pollOnce = async () => {
    const client = await pool.connect();
    let processed = 0;
    try {
        await client.query("BEGIN");
        const rows = await claimBatch(client, BATCH_SIZE);

        for (const row of rows) {
            try {
                await applyToElasticsearch(esClient, row);
                await markPublished(client, row.id);
                processed++;
            } catch (err) {
                console.error(`outbox-poller: failed to apply row ${row.id} (${row.aggregateType}):`, err.message);
                // Left unmarked on purpose — falls through to COMMIT below still
                // unpublished, eligible for the next tick.
            }
        }

        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("outbox-poller: batch failed", err.message);
    } finally {
        client.release();
    }
    return processed;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runLoop = async () => {
    try {
        await connectDB();
    } catch (error) {
        // Unlike Elasticsearch, Postgres is not optional for this process —
        // every batch it runs reads the outbox table, so a Postgres it can't
        // reach at all means there is nothing useful left for it to do.
        console.error("outbox-poller: could not connect to Postgres:", error.message);
        process.exit(1);
    }

    // Best-effort, not a startup gate — same reasoning as Search Service: a
    // poller that refuses to start because ES is down would mean Postgres
    // writes stop draining even once ES recovers, since nothing would be left
    // running to notice.
    ensureSearchIndex().catch((err) =>
        console.error("outbox-poller: could not ensure search index (will retry lazily):", err.message)
    );

    console.log(`outbox-poller: running, batch=${BATCH_SIZE}, interval=${POLL_INTERVAL_MS}ms`);

    let stopping = false;
    const shutdown = (signal) => {
        console.log(`${signal} received, finishing current batch then exiting`);
        stopping = true;
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    while (!stopping) {
        const processed = await pollOnce().catch((err) => {
            console.error("outbox-poller: unexpected error in pollOnce", err);
            return 0;
        });
        if (processed === 0) {
            await sleep(POLL_INTERVAL_MS);
        }
        // A full batch is retried immediately, not delayed — there may be more
        // waiting right behind it.
    }

    await pool.end();
    process.exit(0);
};

// Only run the loop when this file is executed directly — importing pollOnce
// for a test must not also start the infinite loop.
if (import.meta.url === `file://${process.argv[1]}`) {
    runLoop();
}
