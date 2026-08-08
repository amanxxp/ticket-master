#!/usr/bin/env node
// Week 5 Day 3 acceptance: the lottery draw must decorrelate queue position from
// arrival time. "Looks random" is not the bar — this measures it.
//
// Usage:
//   node scripts/fairness-test.js [--n 1000] [--url http://localhost:3004]
//
// Requires: booking service running, Postgres + Redis up. Creates its own event
// so it never depends on seed data, and leaves it behind for inspection.

import { Client } from "pg";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
};

const N = Number(argOf("--n", 1000));
const BASE = argOf("--url", "http://localhost:3004");

const db = new Client({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "ticketmaster",
    password: process.env.DB_PASSWORD || "ticketmaster",
    database: process.env.DB_NAME || "ticketmaster",
});

let pass = 0;
let fail = 0;
const ok = (cond, label, detail = "") => {
    if (cond) {
        pass++;
        console.log(`  PASS  ${label}`);
    } else {
        fail++;
        console.log(`  FAIL  ${label}  ${detail}`);
    }
};

// Pearson correlation between join order and final queue position. Under FIFO
// this is exactly 1 by construction; under a fair draw it should sit near 0.
//
// The threshold is derived, not picked by feel: for n independent samples the
// sample correlation of two unrelated sequences has standard error ≈ 1/sqrt(n-1),
// so |r| > 4 standard errors is a ~1-in-15000 event under the null hypothesis of
// no relationship. Failing at that bound means the draw is genuinely leaking
// arrival order, not that this run got unlucky.
const pearson = (xs, ys) => {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
        const a = xs[i] - mx;
        const b = ys[i] - my;
        num += a * b;
        dx += a * a;
        dy += b * b;
    }
    return num / Math.sqrt(dx * dy);
};

// Correlation catches a monotone leak. It does not catch "first half of arrivals
// all landed in the first half of the queue, shuffled within it" — that has r≈0
// but is not fair. A chi-square over an arrival-quartile × position-quartile grid
// does catch it: under a fair draw each of the 16 cells should hold ~n/16.
const chiSquareQuartiles = (order, positions, n) => {
    const q = (v) => Math.min(3, Math.floor((v / n) * 4));
    const grid = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) grid[q(order[i])][q(positions[i] - 1)]++;

    const expected = n / 16;
    let chi = 0;
    for (const row of grid) {
        for (const cell of row) chi += ((cell - expected) ** 2) / expected;
    }
    return { chi, grid };
};

// The window opens an hour out and is then moved to `now()` explicitly once every
// registration is in. Any wall-clock estimate races the machine: a fixed 4s window
// (and later a scaled one) let the sale open PARTWAY through registration, so the
// tail of the registrants were appended as latecomers and the correlation test
// measured a queue that was half draw and half FIFO — reported as a fairness
// failure when it was really a fixture failure.
const REGISTRATION_WINDOW_SECONDS = 3600;

const setup = async () => {
    const venue = await db.query(
        `INSERT INTO venues (name, location, seat_map) VALUES ('Fairness Venue','Nowhere','{}') RETURNING id`
    );
    const performer = await db.query(
        `INSERT INTO performers (name) VALUES ('Fairness Performer') RETURNING id`
    );

    // sale_opens_at a few seconds out, so registration is genuinely a window we
    // pass through rather than a branch we skip.
    const event = await db.query(
        `INSERT INTO events
           (name, description, venue_id, performer_id, event_date,
            max_tickets_per_user, queue_mode, sale_opens_at)
         VALUES ('Fairness Draw', 'lottery', $1, $2, now() + interval '30 days',
                 4, 'lottery', now() + make_interval(secs => $3::int))
         RETURNING id, sale_opens_at AS "saleOpensAt"`,
        [venue.rows[0].id, performer.rows[0].id, REGISTRATION_WINDOW_SECONDS]
    );

    // Available inventory, deliberately. Zero available is NOT a safe alternative:
    // the admitter treats an event with nothing left to sell as sold out and drains
    // the entire queue, which empties the very thing this test measures.
    await db.query(
        `INSERT INTO tickets (event_id, seat, price)
         SELECT $1, 'S' || g, 100.00 FROM generate_series(1, 50) g`,
        [event.rows[0].id]
    );

    return event.rows[0];
};

const poll = (eventId, userId, token) =>
    fetch(`${BASE}/queue/position?eventId=${eventId}`, {
        headers: { "x-user-id": String(userId), "x-queue-token": token },
    });

const post = (path, body, userId) =>
    fetch(BASE + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": String(userId) },
        body: JSON.stringify(body),
    });

// This test measures ORDER in a live queue, so it requires that nothing is
// removing members while it runs. A running admitter legitimately drains the head
// of the queue, which shifts every position behind it — the measurement would then
// report a fairness failure for what is actually correct admission behaviour.
//
// Detected and refused rather than worked around: there is no way to measure a
// moving queue's order, and silently producing a number anyway would be worse than
// not running.
const assertNoAdmitter = async () => {
    const { createClient } = await import("redis");
    const redis = createClient({ socket: { host: "localhost", port: 6379 } });
    redis.on("error", () => {});
    await redis.connect();
    const lease = await redis.keys("admitter:leader*");
    await redis.quit();
    if (lease.length > 0) {
        console.error(
            "\nREFUSING TO RUN: an admitter holds a leader lease.\n" +
            "It will drain the queue mid-measurement and every position assertion\n" +
            "below becomes meaningless. Stop the admitter(s) and re-run.\n"
        );
        process.exit(2);
    }
};

const main = async () => {
    await db.connect();
    await assertNoAdmitter();
    const event = await setup();
    const eventId = String(event.id);
    console.log(`\nevent ${eventId}, lottery mode, sale opens ${event.saleOpensAt.toISOString()}`);

    // ---- registration window --------------------------------------------
    // Sequentially, so arrival order is unambiguous and index i really is the
    // i-th arrival. Concurrent joins would make "join order" meaningless and the
    // correlation untestable.
    console.log(`\n1. Registration window — ${N} sequential registrations`);
    const userIds = [];
    const tokens = new Map();
    let registeredCount = 0;
    let leakedPosition = 0;

    for (let i = 0; i < N; i++) {
        const userId = 1_000_000 + i;
        const res = await post("/queue/join", { eventId }, userId);
        const body = await res.json();
        const data = body.data;

        if (res.status !== 200 && res.status !== 201) {
            console.log(`  join failed for ${userId}: ${res.status} ${JSON.stringify(body)}`);
            break;
        }
        if (data.status === "registered") registeredCount++;
        if (data.position !== null) leakedPosition++;
        userIds.push(String(userId));
        tokens.set(String(userId), data.token);
    }

    ok(registeredCount === N, `all ${N} land in 'registered'`, `got ${registeredCount}`);
    ok(leakedPosition === 0, "no position exposed during registration", `${leakedPosition} leaked`);

    const preOpen = await db.query(`SELECT draw_seed FROM events WHERE id = $1`, [eventId]);
    ok(preOpen.rows[0].draw_seed === null, "draw_seed is NULL before sale-open — nothing to guess");

    // ---- sale opens ------------------------------------------------------
    console.log("\n2. Sale opens — first poll triggers the draw");
    // Close the window deterministically instead of waiting for it. The draw itself
    // is still triggered by a real request against a real post-open event — only the
    // clock is controlled.
    await db.query(`UPDATE events SET sale_opens_at = now() - interval '1 second' WHERE id = $1`,
        [eventId]);

    const firstUser = userIds[0];
    const firstPoll = await poll(eventId, firstUser, tokens.get(firstUser));
    const firstBody = await firstPoll.json();
    ok(firstPoll.status === 200, "poll after open succeeds", String(firstPoll.status));
    ok(firstBody.data?.status === "waiting", "status flips to waiting", JSON.stringify(firstBody.data?.status));

    const postOpen = await db.query(`SELECT draw_seed FROM events WHERE id = $1`, [eventId]);
    ok(typeof postOpen.rows[0].draw_seed === "string" && postOpen.rows[0].draw_seed.length === 64,
        "seed materialised at open, 32 bytes hex", `len ${postOpen.rows[0].draw_seed?.length}`);

    // ---- the measurement -------------------------------------------------
    console.log("\n3. Correlation between arrival order and drawn position");
    const positions = [];
    const order = [];
    for (let i = 0; i < userIds.length; i++) {
        const userId = userIds[i];
        const res = await poll(eventId, userId, tokens.get(userId));
        const body = await res.json();
        const position = body.data?.position;
        if (typeof position !== "number") {
            console.log(`  no position for ${userId}: ${res.status} ${JSON.stringify(body)}`);
            continue;
        }
        order.push(i);
        positions.push(position);
    }

    const n = positions.length;
    ok(n === N, `every registrant has a position`, `${n}/${N}`);

    const uniquePositions = new Set(positions).size;
    ok(uniquePositions === n, "positions are unique — no two users share a rank",
        `${uniquePositions} unique of ${n}`);

    const r = pearson(order, positions);
    const stderr = 1 / Math.sqrt(n - 1);
    const bound = 4 * stderr;
    console.log(`  r = ${r.toFixed(5)}   |r| bound = ${bound.toFixed(5)} (4 × 1/sqrt(n-1))`);
    ok(Math.abs(r) < bound, "arrival order and position are uncorrelated",
        `|r|=${Math.abs(r).toFixed(5)} exceeds ${bound.toFixed(5)}`);

    const { chi, grid } = chiSquareQuartiles(order, positions, n);
    // 9 degrees of freedom, p=0.001 → 27.88. A monotone-free but still clustered
    // draw fails here even when r is ~0.
    console.log(`  chi-square (4x4 quartiles, 9 df) = ${chi.toFixed(2)}   threshold 27.88 (p=0.001)`);
    for (const row of grid) console.log(`    ${row.map((c) => String(c).padStart(5)).join("")}`);
    ok(chi < 27.88, "arrival quartile does not predict position quartile", `chi=${chi.toFixed(2)}`);

    // ---- monotonicity under late joins -----------------------------------
    // The draw is done. 100 latecomers now arrive. Nobody already holding a
    // position may see it worsen — this is the property a hash-scored late join
    // would silently break, since inserting mid-ZSET shifts every rank behind it.
    console.log("\n4. Monotonicity: 100 late joins must not move existing positions");
    const sample = userIds.filter((_, i) => i % 10 === 0);
    const before = new Map();
    for (const userId of sample) {
        const body = await (await poll(eventId, userId, tokens.get(userId))).json();
        before.set(userId, body.data?.position);
    }

    const latePositions = [];
    for (let i = 0; i < 100; i++) {
        const res = await post("/queue/join", { eventId }, 3_000_000 + i);
        const body = await res.json();
        if (typeof body.data?.position === "number") latePositions.push(body.data.position);
    }

    let worsened = 0;
    for (const userId of sample) {
        const body = await (await poll(eventId, userId, tokens.get(userId))).json();
        const after = body.data?.position;
        if (typeof after !== "number" || after > before.get(userId)) worsened++;
    }
    ok(worsened === 0, "no registrant's position increased after 100 late joins",
        `${worsened} of ${sample.length} worsened`);
    ok(latePositions.every((p) => p > N), "every latecomer lands behind all registrants",
        `min late position ${Math.min(...latePositions)} should exceed ${N}`);
    ok(latePositions.every((p, i) => i === 0 || p > latePositions[i - 1]),
        "latecomers are FIFO among themselves");

    // ---- FIFO comparison -------------------------------------------------
    // Same measurement against fifo mode. If this does NOT show a correlation of
    // ~1, the test itself is broken and the lottery result above means nothing.
    console.log("\n5. Control: same measurement in fifo mode (expect r ≈ 1)");
    const fifoEvent = await db.query(
        `INSERT INTO events (name, venue_id, performer_id, event_date, max_tickets_per_user, queue_mode)
         SELECT 'Fairness FIFO', venue_id, performer_id, event_date, 4, 'fifo'
         FROM events WHERE id = $1 RETURNING id`,
        [eventId]
    );
    const fifoId = String(fifoEvent.rows[0].id);
    await db.query(
        `INSERT INTO tickets (event_id, seat, price)
         SELECT $1, 'C' || g, 100.00 FROM generate_series(1, 10) g`, [fifoId]);

    const fifoPositions = [];
    const controlN = Math.min(200, N);
    for (let i = 0; i < controlN; i++) {
        const res = await post("/queue/join", { eventId: fifoId }, 2_000_000 + i);
        const body = await res.json();
        if (typeof body.data?.position === "number") fifoPositions.push(body.data.position);
    }
    const fifoR = pearson(fifoPositions.map((_, i) => i), fifoPositions);
    console.log(`  fifo r = ${fifoR.toFixed(5)}`);
    ok(fifoR > 0.99, "fifo really is arrival-ordered — the measurement works", `r=${fifoR.toFixed(5)}`);

    console.log(`\n${pass} passed, ${fail} failed`);
    console.log(`(left behind: lottery event ${eventId}, fifo event ${fifoId})\n`);
    await db.end();
    process.exit(fail === 0 ? 0 : 1);
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
