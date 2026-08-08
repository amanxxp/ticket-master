#!/usr/bin/env node
// Week 5 Day 5 acceptance: 10,000 queue joins → zero 500s, zero over-admission,
// and the actual Postgres connection count recorded against max_connections.
//
//   node scripts/queue-load-test.js [--n 10000] [--concurrency 100]
//
// Run the admitter alongside this to exercise admission under load:
//   cd services/admitter && npm start
//
// This does NOT pre-create users. Queue membership is Redis-only and the join
// path never touches the users table, so 10k rows would measure Postgres insert
// throughput rather than the queue.

import { Client } from "pg";

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };

const N = Number(argOf("--n", 10000));
const CONCURRENCY = Number(argOf("--concurrency", 100));
const BASE = argOf("--url", "http://localhost:3004");
const TICKETS = Number(argOf("--tickets", 100));

const db = new Client({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "ticketmaster",
    password: process.env.DB_PASSWORD || "ticketmaster",
    database: process.env.DB_NAME || "ticketmaster",
});

let pass = 0, fail = 0;
const ok = (c, label, detail = "") => {
    if (c) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

// Sampled while the load is in flight, not after. Pool usage collapses back to
// idle the moment the run ends, so a reading taken afterwards would always look
// healthy and would prove nothing.
const sampleConnections = async () => {
    const { rows } = await db.query(
        `SELECT
           (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max,
           count(*)::int AS total,
           count(*) FILTER (WHERE state = 'active')::int AS active,
           count(*) FILTER (WHERE state = 'idle')::int AS idle
         FROM pg_stat_activity
         WHERE datname = current_database()`
    );
    return rows[0];
};

const setup = async () => {
    const v = await db.query(`INSERT INTO venues (name,location,seat_map) VALUES ('LV','X','{}') RETURNING id`);
    const p = await db.query(`INSERT INTO performers (name) VALUES ('LP') RETURNING id`);
    const e = await db.query(
        `INSERT INTO events (name, venue_id, performer_id, event_date, max_tickets_per_user, queue_mode)
         VALUES ('Load Test', $1, $2, now() + interval '30 days', 4, 'fifo') RETURNING id`,
        [v.rows[0].id, p.rows[0].id]
    );
    const eventId = String(e.rows[0].id);
    await db.query(
        `INSERT INTO tickets (event_id, seat, price)
         SELECT $1, 'L' || g, 100.00 FROM generate_series(1, $2) g`,
        [eventId, TICKETS]
    );
    return eventId;
};

// Bounded worker pool rather than Promise.all over 10k. Firing all of them at
// once measures how fast Node can exhaust its own socket pool, not how the
// service behaves — and the ECONNRESETs that follow would be indistinguishable
// from the server failing.
const runPool = async (total, concurrency, work) => {
    let next = 0;
    const results = [];
    const worker = async () => {
        while (true) {
            const i = next++;
            if (i >= total) return;
            results[i] = await work(i);
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
};

const main = async () => {
    await db.connect();
    const eventId = await setup();
    console.log(`\nevent ${eventId} · ${TICKETS} tickets · ${N} joins · concurrency ${CONCURRENCY}\n`);

    const statuses = new Map();
    const latencies = [];
    let peakConnections = { total: 0 };

    const sampler = setInterval(async () => {
        try {
            const s = await sampleConnections();
            if (s.total > peakConnections.total) peakConnections = s;
        } catch { /* sampler must never fail the run */ }
    }, 250);

    const started = Date.now();
    const results = await runPool(N, CONCURRENCY, async (i) => {
        const t0 = performance.now();
        try {
            const res = await fetch(`${BASE}/queue/join`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-user-id": String(500000 + i) },
                body: JSON.stringify({ eventId }),
            });
            latencies.push(performance.now() - t0);
            const body = await res.json().catch(() => null);
            return { status: res.status, position: body?.data?.position };
        } catch (err) {
            latencies.push(performance.now() - t0);
            return { status: `network:${err.code || err.message}` };
        }
    });
    const elapsedMs = Date.now() - started;
    clearInterval(sampler);

    for (const r of results) statuses.set(r.status, (statuses.get(r.status) || 0) + 1);

    console.log("Status codes:");
    for (const [status, count] of [...statuses].sort()) console.log(`  ${status}: ${count}`);
    console.log(`\nThroughput: ${(N / (elapsedMs / 1000)).toFixed(0)} joins/sec over ${(elapsedMs / 1000).toFixed(1)}s`);

    latencies.sort((a, b) => a - b);
    const pct = (p) => latencies[Math.floor((p / 100) * (latencies.length - 1))].toFixed(1);
    console.log(`Latency ms: p50 ${pct(50)} · p95 ${pct(95)} · p99 ${pct(99)} · max ${pct(100)}`);

    console.log("\n--- Acceptance ---");
    const serverErrors = [...statuses].filter(([s]) => typeof s === "number" && s >= 500)
        .reduce((a, [, c]) => a + c, 0);
    const networkErrors = [...statuses].filter(([s]) => typeof s === "string")
        .reduce((a, [, c]) => a + c, 0);

    ok(serverErrors === 0, "zero 5xx responses", `${serverErrors} server errors`);
    ok(networkErrors === 0, "zero dropped connections", `${networkErrors} network failures`);

    const accepted = (statuses.get(201) || 0) + (statuses.get(200) || 0);
    ok(accepted === N, `all ${N} joins accepted`, `${accepted}`);

    const positions = results.map((r) => r.position).filter((p) => typeof p === "number");
    ok(positions.length === N, "every join received a position", `${positions.length}/${N}`);
    ok(Math.min(...positions) === 1, "first joiner got position 1", `min ${Math.min(...positions)}`);
    ok(Math.max(...positions) <= N, "no position exceeds the number of joins",
        `max ${Math.max(...positions)}`);

    // ---- over-admission ---------------------------------------------------
    // The real bound: nobody may hold a live admission beyond
    // floor(available × OVERBOOKING_FACTOR). Checked against the admitter's own
    // configured factor, defaulting to the same 1.1 the worker defaults to.
    const factor = Number(process.env.OVERBOOKING_FACTOR || 1.1);
    const { rows: [inv] } = await db.query(
        `SELECT count(*)::int c FROM tickets WHERE event_id = $1 AND status = 'available'`, [eventId]
    );
    const { createClient } = await import("redis");
    const redis = createClient({ socket: { host: "localhost", port: 6379 } });
    await redis.connect();
    const liveAdmissions = await redis.zCount(`queue:{evt:${eventId}}:admitted`, Date.now(), "+inf");
    const queueLength = await redis.zCard(`queue:{evt:${eventId}}`);
    await redis.quit();

    const cap = Math.floor(inv.c * factor);
    console.log(`\nInventory ${inv.c} · overbooking ×${factor} · cap ${cap}`);
    console.log(`Live admissions ${liveAdmissions} · still waiting ${queueLength}`);
    ok(liveAdmissions <= cap, "no over-admission", `${liveAdmissions} admitted exceeds cap ${cap}`);

    // Positions are derived from ZRANK against a live queue, so they are only
    // unique while nothing is draining. With the admitter running, a user removed
    // mid-run shifts everyone behind them down by one and two joins can honestly
    // report the same number — `unique + admitted === N` is the invariant that
    // survives concurrent draining, and it is the one worth asserting.
    const unique = new Set(positions).size;
    if (liveAdmissions === 0) {
        console.log("\n  NOTE  admitter was not running — the over-admission bound held");
        console.log("        trivially. Start `cd services/admitter && npm start` to test it.");
        ok(unique === N, "no admitter draining: every position unique", `${unique} of ${N}`);
    } else {
        console.log(`\nQueue drained during the run: ${liveAdmissions} admitted, ${unique} distinct positions`);
        ok(unique + liveAdmissions >= N - 1 && unique + liveAdmissions <= N + 1,
            "distinct positions + admitted accounts for every join",
            `${unique} + ${liveAdmissions} = ${unique + liveAdmissions}, expected ~${N}`);
        ok(queueLength + liveAdmissions === N,
            "queue length + admitted == joins — nobody lost",
            `${queueLength} + ${liveAdmissions} = ${queueLength + liveAdmissions} vs ${N}`);
    }

    // ---- connection budget -------------------------------------------------
    const final = await sampleConnections();
    const peak = peakConnections.total ? peakConnections : final;
    console.log(`\nPostgres connections — peak observed ${peak.total} of max_connections ${final.max}`);
    console.log(`  (peak active ${peak.active}, idle ${peak.idle})`);
    console.log(`  headroom: ${final.max - peak.total} connections`);
    ok(peak.total < final.max, "peak connections stayed under max_connections",
        `${peak.total} vs ${final.max}`);
    ok(peak.total < final.max * 0.8, "peak stayed under 80% of max_connections — real headroom",
        `${peak.total}/${final.max} = ${((peak.total / final.max) * 100).toFixed(0)}%`);

    console.log(`\n${pass} passed, ${fail} failed\n`);
    await db.end();
    process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(1); });
