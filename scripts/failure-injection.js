#!/usr/bin/env node
// Week 6 Day 3 acceptance: break it deliberately, eight ways, and verify the
// system's own stated invariants survive. Week 6 Day 4's acceptance rides along —
// every inconsistency injected here must be resolvable by the reconciler.
//
//   1. Fill in PREDICTIONS.md first. Then:
//   2. node scripts/failure-injection.js
//
// This script starts and stops its own booking-service processes, so do not have
// one already listening on the ports it uses (3104, 3105).

import { Client } from "pg";
import { spawn, execSync } from "node:child_process";
import { createClient } from "redis";
import jwt from "jsonwebtoken";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const BOOKING_DIR = path.join(REPO, "services/booking");
const PORT_A = 3104;
const PORT_B = 3105;
const ADMISSION_SECRET = process.env.ADMISSION_TOKEN_SECRET || "changeme";

const admissionFor = (userId, eventId) =>
    jwt.sign({ eventId: String(eventId) }, ADMISSION_SECRET, { subject: String(userId), expiresIn: 900 });

const db = new Client({
    host: "localhost", port: 5432, user: "ticketmaster",
    password: "ticketmaster", database: "ticketmaster",
});

let pass = 0, fail = 0;
const ok = (c, label, detail = "") => {
    if (c) { pass++; console.log(`    PASS  ${label}`); }
    else { fail++; console.log(`    FAIL  ${label}  ${detail}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- process control -----------------------------------------------------
const startBooking = async (port, extraEnv = {}) => {
    const child = spawn("node", ["server.js"], {
        cwd: BOOKING_DIR,
        env: { ...process.env, PORT: String(port), STRIPE_MODE: "fake", ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});

    for (let i = 0; i < 60; i++) {
        try {
            const r = await fetch(`http://localhost:${port}/health`);
            if (r.ok) return child;
        } catch { /* not up yet */ }
        await sleep(200);
    }
    throw new Error(`booking service on ${port} never became healthy`);
};

const stopBooking = async (child, signal = "SIGTERM") => {
    if (!child || child.exitCode !== null) return;
    child.kill(signal);
    for (let i = 0; i < 50; i++) {
        if (child.exitCode !== null) return;
        await sleep(100);
    }
    child.kill("SIGKILL");
};

const CALL_TIMEOUT_MS = 8000;

const call = async (port, method, p, { userId, body, admission } = {}) => {
    try {
        const res = await fetch(`http://localhost:${port}${p}`, {
            // A drill that hangs cannot report a hang. An unbounded fetch here made
            // the whole harness stop dead the first time a Redis-down request never
            // returned — which was the bug, but it was invisible because the tool
            // looking for it froze too.
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
            method,
            headers: {
                "content-type": "application/json",
                ...(userId ? { "x-user-id": String(userId) } : {}),
                ...(admission ? { "x-admission-token": admission } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, json: await res.json().catch(() => null) };
    } catch (err) {
        const hung = err.name === "TimeoutError" || err.name === "AbortError";
        return { status: hung ? "TIMEOUT" : `network:${err.code || err.message}`, json: null };
    }
};

const redisCli = (...args) =>
    execSync(`docker-compose exec -T redis redis-cli ${args.join(" ")}`, { cwd: REPO }).toString().trim();

// ---- fixtures ------------------------------------------------------------
let fixtureSeq = 0;
const setup = async (ticketCount = 4) => {
    const tag = `fi${Date.now()}-${fixtureSeq++}`;
    const v = await db.query(`INSERT INTO venues (name,location,seat_map) VALUES ($1,'X','{}') RETURNING id`, [tag]);
    const p = await db.query(`INSERT INTO performers (name) VALUES ($1) RETURNING id`, [tag]);
    const e = await db.query(
        `INSERT INTO events (name, venue_id, performer_id, event_date, max_tickets_per_user)
         VALUES ($1,$2,$3, now() + interval '30 days', 10) RETURNING id`,
        [tag, v.rows[0].id, p.rows[0].id]
    );
    const eventId = String(e.rows[0].id);
    const t = await db.query(
        `INSERT INTO tickets (event_id, seat, price)
         SELECT $1,'F'||g, 1500.00 FROM generate_series(1,$2) g RETURNING id`, [eventId, ticketCount]);
    const u = await db.query(
        `INSERT INTO users (email,password_hash,role)
         SELECT $1||'-'||g||'@t.in','x','user' FROM generate_series(1,3) g RETURNING id`, [tag]);
    return { eventId, ticketIds: t.rows.map(r => String(r.id)), userIds: u.rows.map(r => String(r.id)) };
};

const bookingRow = async (id) => (await db.query(
    `SELECT status, total_amount::text FROM bookings WHERE id = $1`, [id])).rows[0];
const paymentRow = async (bookingId) => (await db.query(
    `SELECT status, provider_ref FROM payments WHERE booking_id = $1`, [bookingId])).rows[0];
const ticketStatuses = async (ids) => (await db.query(
    `SELECT status, count(*)::int c FROM tickets WHERE id = ANY($1::bigint[]) GROUP BY status`, [ids])).rows;

const runReconciler = () =>
    execSync("node reconciler.js --once", {
        cwd: path.join(REPO, "services/reconciler"),
        env: { ...process.env, STRIPE_MODE: "fake", RECONCILE_PENDING_AFTER_SECONDS: "0" },
    }).toString();

// =========================================================================
const main = async () => {
    await db.connect();
    const redis = createClient({ socket: { host: "localhost", port: 6379 } });
    // Scenario 4 stops the Redis container out from under this client. Without a
    // handler, node-redis emits an unhandled 'error' and takes the harness down
    // mid-run — the drill would kill the thing running the drill.
    redis.on("error", () => {});
    await redis.connect();

    console.log("\n=== Week 6 Day 3 — failure injection ===");
    console.log("Predictions should already be written in PREDICTIONS.md.\n");

    let svc = await startBooking(PORT_A);

    // ---- 1. crash between charge and DB confirm --------------------------
    console.log("1. Kill the process between the Stripe charge and the DB confirm");
    {
        const f = await setup();
        const buyer = f.userIds[0];
        const seats = f.ticketIds.slice(0, 2);

        await stopBooking(svc);
        const crashing = await startBooking(PORT_A, { BOOKING_CRASH_AFTER_CHARGE: "true" });
        const res = await call(PORT_A, "POST", "/bookings/confirm", {
            userId: buyer, admission: admissionFor(buyer, f.eventId),
            body: { eventId: f.eventId, ticketIds: seats, paymentMethodId: "pm_test_visa" },
        });
        ok(String(res.status).startsWith("network"), "the request dies with the process", String(res.status));
        await sleep(500);
        ok(crashing.exitCode !== null, "process actually exited", String(crashing.exitCode));

        const { rows: [bk] } = await db.query(
            `SELECT id, status FROM bookings WHERE event_id = $1`, [f.eventId]);
        ok(bk?.status === "pending", "booking left 'pending' — money moved, nothing settled", bk?.status);
        const pay = await paymentRow(bk.id);
        ok(pay?.status === "pending", "payments row survives, still 'pending'", pay?.status);
        ok(pay?.provider_ref === null, "no provider_ref — this is the ambiguous case", String(pay?.provider_ref));

        // Day 4's acceptance: the reconciler must resolve exactly this.
        const out = runReconciler();
        const bkAfter = await bookingRow(bk.id);
        const payAfter = await paymentRow(bk.id);
        ok(payAfter.status === "succeeded",
            "reconciler found the charge at the provider and settled it", payAfter.status);
        ok(payAfter.provider_ref?.startsWith("pi_"), "provider_ref backfilled", payAfter.provider_ref);
        ok(bkAfter.status === "confirmed",
            "booking promoted — seats NOT resold, the customer paid for them", bkAfter.status);
        ok(/"pendingSettled":1/.test(out), "reconciler reported the settlement", out.trim().split("\n").pop());

        svc = await startBooking(PORT_A);
    }

    // ---- 2. hold expires mid-payment ------------------------------------
    console.log("\n2. Hold expires mid-payment");
    {
        const f = await setup();
        const buyer = f.userIds[0];
        const seat = f.ticketIds.slice(0, 1);
        const admission = admissionFor(buyer, f.eventId);

        const held = await call(PORT_A, "POST", "/bookings/reserve", {
            userId: buyer, admission, body: { eventId: f.eventId, ticketIds: seat },
        });
        ok(held.status === 201, "hold created", String(held.status));

        // Rewind the score rather than waiting 10 minutes. Expiry is score-based,
        // so this is exactly what a lapsed TTL looks like to every reader.
        redisCli("ZADD", `'hold:{evt:${f.eventId}}:seats'`, "1", seat[0]);

        const confirmed = await call(PORT_A, "POST", "/bookings/confirm", {
            userId: buyer, admission, body: { eventId: f.eventId, ticketIds: seat, paymentMethodId: "pm_test_visa" },
        });
        ok(confirmed.status === 201,
            "confirm still succeeds — the hold is an optimization, Postgres is the arbiter",
            String(confirmed.status));

        const other = f.userIds[1];
        const stolen = await call(PORT_A, "POST", "/bookings/reserve", {
            userId: other, admission: admissionFor(other, f.eventId),
            body: { eventId: f.eventId, ticketIds: seat },
        });
        ok(stolen.status === 409, "and nobody else can take the sold seat", String(stolen.status));
    }

    // ---- 3. FLUSHALL mid-booking ----------------------------------------
    console.log("\n3. FLUSHALL Redis mid-booking");
    {
        const f = await setup();
        const buyer = f.userIds[0];
        const seats = f.ticketIds.slice(0, 2);
        const admission = admissionFor(buyer, f.eventId);

        await call(PORT_A, "POST", "/bookings/reserve", {
            userId: buyer, admission, body: { eventId: f.eventId, ticketIds: seats },
        });
        redisCli("FLUSHALL");

        const confirmed = await call(PORT_A, "POST", "/bookings/confirm", {
            userId: buyer, admission, body: { eventId: f.eventId, ticketIds: seats, paymentMethodId: "pm_test_visa" },
        });
        ok(confirmed.status === 201, "confirm unaffected by losing every hold", String(confirmed.status));

        const other = f.userIds[1];
        const race = await call(PORT_A, "POST", "/bookings/confirm", {
            userId: other, admission: admissionFor(other, f.eventId),
            body: { eventId: f.eventId, ticketIds: seats, paymentMethodId: "pm_test_visa" },
        });
        ok(race.status === 409, "zero double-books despite no holds existing", String(race.status));

        const statuses = await ticketStatuses(seats);
        ok(statuses.length === 1 && statuses[0].status === "booked",
            "both seats booked exactly once", JSON.stringify(statuses));
    }

    // ---- 4. Redis down entirely -----------------------------------------
    console.log("\n4. Redis down entirely");
    {
        const f = await setup();
        const buyer = f.userIds[0];
        const seat = f.ticketIds.slice(0, 1);
        const admission = admissionFor(buyer, f.eventId);

        execSync("docker-compose stop redis", { cwd: REPO, stdio: "ignore" });
        await sleep(1000);
        try {
            const reserve = await call(PORT_A, "POST", "/bookings/reserve", {
                userId: buyer, admission, body: { eventId: f.eventId, ticketIds: seat },
            });
            ok(reserve.status !== "TIMEOUT",
                "reserve does NOT hang — disableOfflineQueue makes it reject immediately",
                "request never returned; node-redis queued the command forever");
            ok(typeof reserve.status === "number" && reserve.status >= 500 && reserve.status < 600,
                "reserve fails with a clean 5xx, not a stack trace to the client",
                String(reserve.status));
            ok(reserve.json?.error?.correlationId, "and still carries a correlationId",
                JSON.stringify(reserve.json));

            const confirm = await call(PORT_A, "POST", "/bookings/confirm", {
                userId: buyer, admission,
                body: { eventId: f.eventId, ticketIds: seat, paymentMethodId: "pm_test_visa" },
            });
            ok(confirm.status === 201,
                "confirm STILL WORKS with Redis down — Postgres is the arbiter",
                String(confirm.status));

            const health = await fetch(`http://localhost:${PORT_A}/health`);
            ok(health.ok, "service stays up rather than crash-looping", String(health.status));
        } finally {
            execSync("docker-compose start redis", { cwd: REPO, stdio: "ignore" });
            await sleep(2500);
        }
        const recovered = await call(PORT_A, "POST", "/bookings/reserve", {
            userId: f.userIds[1], admission: admissionFor(f.userIds[1], f.eventId),
            body: { eventId: f.eventId, ticketIds: f.ticketIds.slice(1, 2) },
        });
        ok(recovered.status === 201, "reserve recovers on its own once Redis returns",
            String(recovered.status));
    }

    // ---- 5. Elasticsearch down ------------------------------------------
    console.log("\n5. Elasticsearch down");
    {
        const esUp = await fetch("http://localhost:9200/_cluster/health").then(() => true).catch(() => false);
        if (!esUp) {
            console.log("    SKIP  Elasticsearch was not running to begin with");
        } else {
            execSync("docker-compose stop elasticsearch", { cwd: REPO, stdio: "ignore" });
            await sleep(1500);
            try {
                const f = await setup();
                const buyer = f.userIds[0];
                const confirm = await call(PORT_A, "POST", "/bookings/confirm", {
                    userId: buyer, admission: admissionFor(buyer, f.eventId),
                    body: { eventId: f.eventId, ticketIds: f.ticketIds.slice(0, 1), paymentMethodId: "pm_test_visa" },
                });
                ok(confirm.status === 201, "bookings unaffected by ES being down", String(confirm.status));
                const { rows } = await db.query(
                    `SELECT count(*)::int c FROM outbox WHERE published_at IS NULL`);
                ok(rows[0].c >= 1, "outbox accumulates unpublished rows for later", String(rows[0].c));
            } finally {
                // Started without waiting: ES takes ~30s to become healthy and
                // nothing after this scenario depends on it.
                spawn("docker-compose", ["start", "elasticsearch"], { cwd: REPO, stdio: "ignore", detached: true }).unref();
            }
        }
    }

    // ---- 6. two instances, same ticket, same instant ---------------------
    console.log("\n6. Two Booking Service instances, same ticket, same instant");
    {
        const svcB = await startBooking(PORT_B);
        try {
            const f = await setup();
            const seat = f.ticketIds.slice(0, 1);
            const [u1, u2] = f.userIds;

            const [a, b] = await Promise.all([
                call(PORT_A, "POST", "/bookings/confirm", {
                    userId: u1, admission: admissionFor(u1, f.eventId),
                    body: { eventId: f.eventId, ticketIds: seat, paymentMethodId: "pm_test_visa" },
                }),
                call(PORT_B, "POST", "/bookings/confirm", {
                    userId: u2, admission: admissionFor(u2, f.eventId),
                    body: { eventId: f.eventId, ticketIds: seat, paymentMethodId: "pm_test_visa" },
                }),
            ]);
            const codes = [a.status, b.status].sort();
            ok(codes[0] === 201 && codes[1] === 409, "exactly one 201, one 409 across two processes",
                JSON.stringify(codes));

            const items = await db.query(
                `SELECT count(*)::int c FROM booking_items WHERE ticket_id = $1`, [seat[0]]);
            ok(items.rows[0].c === 1, "one booking_items row — UNIQUE(ticket_id) held",
                String(items.rows[0].c));
            const charged = await db.query(
                `SELECT count(*)::int c FROM payments p JOIN bookings b ON b.id = p.booking_id
                 WHERE b.event_id = $1 AND p.status = 'succeeded'`, [f.eventId]);
            ok(charged.rows[0].c === 1, "exactly one customer charged", String(charged.rows[0].c));
        } finally {
            await stopBooking(svcB);
        }
    }

    // ---- 7. Postgres connection killed mid-request -----------------------
    console.log("\n7. Postgres connections killed mid-request");
    {
        const f = await setup();
        const buyer = f.userIds[0];
        const seat = f.ticketIds.slice(0, 1);

        // Terminate this service's backends. The pool must notice and recover
        // rather than serving errors forever.
        await db.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid()
               AND application_name = ''`
        );
        await sleep(500);

        let recovered = false;
        let lastStatus;
        for (let i = 0; i < 8; i++) {
            const r = await call(PORT_A, "POST", "/bookings/confirm", {
                userId: buyer, admission: admissionFor(buyer, f.eventId),
                body: { eventId: f.eventId, ticketIds: seat, paymentMethodId: "pm_test_visa" },
            });
            lastStatus = r.status;
            if (r.status === 201) { recovered = true; break; }
            await sleep(400);
        }
        ok(recovered, "pool recovers without a restart", `last status ${lastStatus}`);

        const health = await fetch(`http://localhost:${PORT_A}/health`);
        ok(health.ok, "process survived the connection loss", String(health.status));

        const half = await db.query(
            `SELECT count(*)::int c FROM bookings WHERE event_id = $1 AND status = 'pending'`, [f.eventId]);
        ok(half.rows[0].c === 0, "no half-written booking left behind", String(half.rows[0].c));
    }

    // ---- 8. SIGTERM during an in-flight confirm --------------------------
    console.log("\n8. SIGTERM during an in-flight confirm");
    {
        const f = await setup();
        const buyer = f.userIds[0];
        const seats = f.ticketIds.slice(0, 2);

        const inFlight = call(PORT_A, "POST", "/bookings/confirm", {
            userId: buyer, admission: admissionFor(buyer, f.eventId),
            body: { eventId: f.eventId, ticketIds: seats, paymentMethodId: "pm_test_visa" },
        });
        // Fired immediately after, so the request is mid-flight when the signal
        // lands. Graceful shutdown must let it finish rather than cutting it.
        await sleep(15);
        await stopBooking(svc, "SIGTERM");
        const res = await inFlight;

        const { rows: bookings } = await db.query(
            `SELECT id, status FROM bookings WHERE event_id = $1`, [f.eventId]);

        if (typeof res.status === "number" && res.status === 201) {
            ok(bookings.length === 1 && bookings[0].status === "confirmed",
                "in-flight request completed cleanly during drain",
                JSON.stringify(bookings));
        } else {
            // Either outcome is acceptable; a HALF-written one is not.
            const terminal = bookings.every((b) => b.status !== "pending");
            ok(bookings.length === 0 || terminal,
                "request rolled back fully or reached a terminal state — never half-written",
                JSON.stringify(bookings));
        }

        const stray = await db.query(
            `SELECT count(*)::int c FROM booking_items bi
             JOIN bookings b ON b.id = bi.booking_id
             WHERE b.event_id = $1 AND b.status = 'cancelled'`, [f.eventId]);
        ok(stray.rows[0].c === 0, "no booking_items orphaned onto a cancelled booking",
            String(stray.rows[0].c));

        svc = await startBooking(PORT_A);
    }

    // ---- Day 4: the reconciler resolves everything ----------------------
    console.log("\n9. Reconciler leaves nothing unresolved (Week 6 Day 4)");
    {
        const out = runReconciler();
        console.log(`    ${out.trim().split("\n").pop()}`);

        const stuck = await db.query(
            `SELECT count(*)::int c FROM payments WHERE status = 'pending'
               AND created_at < now() - interval '1 second'`);
        ok(stuck.rows[0].c === 0, "no payment left 'pending'", String(stuck.rows[0].c));

        const nonTerminal = await db.query(
            `SELECT count(*)::int c FROM bookings b
             JOIN payments p ON p.booking_id = b.id
             WHERE b.status = 'pending' AND p.created_at < now() - interval '1 second'`);
        ok(nonTerminal.rows[0].c === 0, "no booking left non-terminal (invariant 4)",
            String(nonTerminal.rows[0].c));

        // Drift: a ticket booked in Postgres must not still be held in Redis.
        const { rows: events } = await db.query(
            `SELECT DISTINCT event_id::text id FROM bookings WHERE created_at > now() - interval '1 hour'`);
        let drift = 0;
        for (const { id } of events) {
            const held = await redis.zRangeByScore(`hold:{evt:${id}}:seats`, Date.now(), "+inf");
            if (held.length === 0) continue;
            const { rows } = await db.query(
                `SELECT count(*)::int c FROM tickets WHERE id = ANY($1::bigint[]) AND status = 'booked'`,
                [held]);
            drift += rows[0].c;
        }
        ok(drift === 0, "zero Redis/Postgres drift after the sweep", `${drift} stale holds`);
        ok(/"driftFound"/.test(out), "drift is emitted as a metric, not just fixed silently");
    }

    await stopBooking(svc);
    await redis.quit();
    await db.end();

    console.log(`\n${pass} passed, ${fail} failed`);
    console.log("\nNow record every wrong prediction in PREDICTIONS.md.\n");
    process.exit(fail === 0 ? 0 : 1);
};

main().catch(async (e) => { console.error(e); process.exit(1); });
