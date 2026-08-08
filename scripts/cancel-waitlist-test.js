#!/usr/bin/env node
// Week 5 Day 4 acceptance: cancel is idempotent, releases every ticket, publishes
// to SSE, and a released ticket notifies EXACTLY ONE waitlist user with a claim
// window.
//
//   node scripts/cancel-waitlist-test.js [--url http://localhost:3004]

import { Client } from "pg";
import jwt from "jsonwebtoken";

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const BASE = argOf("--url", "http://localhost:3004");

// The reserve/confirm gate verifies a signed admission token and touches no
// store, so this test mints its own rather than driving the whole
// queue → admitter → admission flow just to exercise cancellation. Signed with
// the same secret Booking Service verifies with — a real token, not a bypass.
const ADMISSION_SECRET = process.env.ADMISSION_TOKEN_SECRET || "changeme";
const admissionFor = (userId, eventId) =>
    jwt.sign({ eventId: String(eventId) }, ADMISSION_SECRET, {
        subject: String(userId),
        expiresIn: 900,
    });

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

const call = async (method, path, { userId, body, admission } = {}) => {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            "content-type": "application/json",
            ...(userId ? { "x-user-id": String(userId) } : {}),
            ...(admission ? { "x-admission-token": admission } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
};

const setup = async () => {
    const v = await db.query(`INSERT INTO venues (name,location,seat_map) VALUES ('CV','X','{}') RETURNING id`);
    const p = await db.query(`INSERT INTO performers (name) VALUES ('CP') RETURNING id`);
    const e = await db.query(
        `INSERT INTO events (name, venue_id, performer_id, event_date, max_tickets_per_user)
         VALUES ('Cancel Test', $1, $2, now() + interval '30 days', 10) RETURNING id`,
        [v.rows[0].id, p.rows[0].id]
    );
    const eventId = String(e.rows[0].id);
    const t = await db.query(
        `INSERT INTO tickets (event_id, seat, price)
         SELECT $1, 'C' || g, 500.00 FROM generate_series(1,20) g RETURNING id`,
        [eventId]
    );
    // Emails are namespaced by the event id, so setup() can run repeatedly
    // within a run and across runs without colliding on users_email_key.
    const users = await db.query(
        `INSERT INTO users (email, password_hash, role)
         SELECT 'cw-' || $1 || '-' || g || '@t.in', 'x', 'user'
         FROM generate_series(1,12) g RETURNING id`,
        [eventId]
    );
    return { eventId, ticketIds: t.rows.map((r) => String(r.id)), userIds: users.rows.map((r) => String(r.id)) };
};

const bookFor = async (eventId, userId, ticketIds) => {
    const r = await call("POST", "/bookings/confirm", {
        userId,
        body: { eventId, ticketIds, paymentMethodId: "pm_test_visa" },
        admission: admissionFor(userId, eventId),
    });
    if (r.status !== 201) throw new Error(`confirm failed ${r.status} ${JSON.stringify(r.json)}`);
    return String(r.json.data.id);
};

const main = async () => {
    await db.connect();
    const { eventId, ticketIds, userIds } = await setup();
    const [buyer, other, ...waiters] = userIds;
    console.log(`\nevent ${eventId}, 20 tickets, buyer=${buyer}`);

    // ---- 1. cancel releases every ticket ---------------------------------
    console.log("\n1. Cancel releases every ticket in the booking");
    const threeSeats = ticketIds.slice(0, 3);
    const bookingId = await bookFor(eventId, buyer, threeSeats);

    const beforeStatuses = await db.query(
        `SELECT status, count(*)::int c FROM tickets WHERE id = ANY($1::bigint[]) GROUP BY status`,
        [threeSeats]
    );
    ok(beforeStatuses.rows.length === 1 && beforeStatuses.rows[0].status === "booked",
        "all 3 booked before cancel", JSON.stringify(beforeStatuses.rows));

    const cancelled = await call("POST", `/bookings/${bookingId}/cancel`, { userId: buyer });
    ok(cancelled.status === 200, "cancel returns 200", String(cancelled.status));
    ok(cancelled.json?.data?.status === "refunded",
        "confirmed booking lands on 'refunded', not 'cancelled'", cancelled.json?.data?.status);
    ok(cancelled.json?.data?.releasedTicketIds?.length === 3, "3 tickets reported released",
        JSON.stringify(cancelled.json?.data?.releasedTicketIds));

    const afterStatuses = await db.query(
        `SELECT status, count(*)::int c FROM tickets WHERE id = ANY($1::bigint[]) GROUP BY status`,
        [threeSeats]
    );
    ok(afterStatuses.rows.length === 1 && afterStatuses.rows[0].status === "available",
        "all 3 available after cancel", JSON.stringify(afterStatuses.rows));

    const items = await db.query(`SELECT count(*)::int c FROM booking_items WHERE booking_id = $1`, [bookingId]);
    ok(items.rows[0].c === 0, "booking_items rows deleted — UNIQUE(ticket_id) no longer blocks resale",
        `${items.rows[0].c} rows remain`);

    // ---- 2. released seats are genuinely resellable -----------------------
    console.log("\n2. Released seats are resellable by someone else");
    const resold = await call("POST", "/bookings/confirm", {
        userId: other,
        body: { eventId, ticketIds: threeSeats, paymentMethodId: "pm_test_visa" },
        admission: admissionFor(other, eventId),
    });
    ok(resold.status === 201, "another user can buy the released seats", `${resold.status} ${JSON.stringify(resold.json?.message)}`);

    // ---- 3. idempotency --------------------------------------------------
    console.log("\n3. Cancel is idempotent — one state change, one release");
    const again = await call("POST", `/bookings/${bookingId}/cancel`, { userId: buyer });
    ok(again.status === 409, "second cancel → 409", String(again.status));

    // The seats resold in step 2 must still belong to `other` — a second cancel
    // must not release somebody else's tickets.
    const stillSold = await db.query(
        `SELECT count(*)::int c FROM tickets WHERE id = ANY($1::bigint[]) AND status = 'booked'`,
        [threeSeats]
    );
    ok(stillSold.rows[0].c === 3, "resold seats untouched by the repeat cancel", `${stillSold.rows[0].c}/3 still booked`);

    // ---- 4. authorization -------------------------------------------------
    console.log("\n4. Cancelling someone else's booking");
    const victimBooking = await bookFor(eventId, buyer, ticketIds.slice(3, 4));
    const foreign = await call("POST", `/bookings/${victimBooking}/cancel`, { userId: other });
    ok(foreign.status === 404, "other user's cancel → 404, not 403", String(foreign.status));
    const survived = await db.query(`SELECT status FROM bookings WHERE id = $1`, [victimBooking]);
    ok(survived.rows[0].status === "confirmed", "booking survived the foreign cancel", survived.rows[0].status);

    // ---- 5. waitlist: exactly one notified per released ticket -------------
    console.log("\n5. Waitlist — N released tickets notify N distinct users, in order");
    const wlEvent = await setup();
    const wlBuyer = wlEvent.userIds[0];
    const wlSeats = wlEvent.ticketIds.slice(0, 2);
    const wlBooking = await bookFor(wlEvent.eventId, wlBuyer, wlSeats);

    // Five join the waitlist, sequentially, so arrival order is unambiguous.
    const joined = [];
    for (const userId of wlEvent.userIds.slice(1, 6)) {
        const r = await call("POST", `/events/${wlEvent.eventId}/waitlist`, { userId });
        if (r.status === 201) joined.push(userId);
    }
    ok(joined.length === 5, "5 users on the waitlist", `${joined.length}`);

    const dup = await call("POST", `/events/${wlEvent.eventId}/waitlist`, { userId: joined[0] });
    ok(dup.status === 200 && dup.json?.data?.joined === false,
        "re-joining is an unchanged 200, not a duplicate entry", String(dup.status));

    const wlCancel = await call("POST", `/bookings/${wlBooking}/cancel`, { userId: wlBuyer });
    ok(wlCancel.status === 200, "cancel succeeded", String(wlCancel.status));
    ok(wlCancel.json?.data?.waitlistNotified === 2,
        "2 released tickets → exactly 2 notified", String(wlCancel.json?.data?.waitlistNotified));

    const notified = await db.query(
        `SELECT user_id::text, status, claim_expires_at FROM waitlist
         WHERE event_id = $1 AND status = 'notified' ORDER BY created_at`,
        [wlEvent.eventId]
    );
    ok(notified.rows.length === 2, "exactly 2 rows in 'notified'", String(notified.rows.length));
    ok(new Set(notified.rows.map((r) => r.user_id)).size === 2, "two DISTINCT users, not one twice");
    ok(notified.rows.every((r) => r.claim_expires_at !== null), "each has a claim window");
    ok(notified.rows.map((r) => r.user_id).join(",") === joined.slice(0, 2).join(","),
        "the two earliest joiners were picked — waitlist is FIFO",
        `${notified.rows.map((r) => r.user_id)} vs ${joined.slice(0, 2)}`);

    const stillWaiting = await db.query(
        `SELECT count(*)::int c FROM waitlist WHERE event_id = $1 AND status = 'waiting'`,
        [wlEvent.eventId]
    );
    ok(stillWaiting.rows[0].c === 3, "the other 3 stay 'waiting'", String(stillWaiting.rows[0].c));

    const statusCheck = await call("GET", `/events/${wlEvent.eventId}/waitlist`, { userId: joined[0] });
    ok(statusCheck.json?.data?.status === "notified", "notified user sees their own status",
        statusCheck.json?.data?.status);
    ok(statusCheck.json?.data?.claimExpiresAt != null, "and their claim deadline");

    // ---- 6. concurrent cancels cannot notify the same user twice -----------
    console.log("\n6. Two concurrent cancels — no waitlist user notified twice");
    const cc = await setup();
    const ccBuyerA = cc.userIds[0], ccBuyerB = cc.userIds[1];
    const bookingA = await bookFor(cc.eventId, ccBuyerA, cc.ticketIds.slice(0, 1));
    const bookingB = await bookFor(cc.eventId, ccBuyerB, cc.ticketIds.slice(1, 2));
    for (const userId of cc.userIds.slice(2, 8)) {
        await call("POST", `/events/${cc.eventId}/waitlist`, { userId });
    }

    const [ra, rb] = await Promise.all([
        call("POST", `/bookings/${bookingA}/cancel`, { userId: ccBuyerA }),
        call("POST", `/bookings/${bookingB}/cancel`, { userId: ccBuyerB }),
    ]);
    ok(ra.status === 200 && rb.status === 200, "both cancels succeeded", `${ra.status}/${rb.status}`);

    const ccNotified = await db.query(
        `SELECT user_id::text FROM waitlist WHERE event_id = $1 AND status = 'notified'`,
        [cc.eventId]
    );
    ok(ccNotified.rows.length === 2, "exactly 2 notified across both cancels", String(ccNotified.rows.length));
    ok(new Set(ccNotified.rows.map((r) => r.user_id)).size === 2,
        "no user notified twice — FOR UPDATE SKIP LOCKED held",
        JSON.stringify(ccNotified.rows.map((r) => r.user_id)));

    // ---- 7. SSE publish --------------------------------------------------
    console.log("\n7. Cancel publishes to the availability channel");
    const sse = await setup();
    const sseBuyer = sse.userIds[0];
    const sseBooking = await bookFor(sse.eventId, sseBuyer, sse.ticketIds.slice(0, 2));

    const { createClient } = await import("redis");
    const sub = createClient({ socket: { host: "localhost", port: 6379 } });
    await sub.connect();
    const messages = [];
    await sub.subscribe(`availability:event:${sse.eventId}`, (m) => messages.push(JSON.parse(m)));

    await call("POST", `/bookings/${sseBooking}/cancel`, { userId: sseBuyer });
    await new Promise((r) => setTimeout(r, 400));
    await sub.quit();

    ok(messages.length === 1, "one message published", `got ${messages.length}`);
    ok(messages[0]?.type === "seats.released", "type is seats.released", messages[0]?.type);
    ok(messages[0]?.ticketIds?.length === 2, "carries both released ticket ids",
        JSON.stringify(messages[0]?.ticketIds));
    ok(typeof messages[0]?.correlationId === "string",
        "carries a correlationId across the pub/sub hop");

    console.log(`\n${pass} passed, ${fail} failed\n`);
    await db.end();
    process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(1); });
