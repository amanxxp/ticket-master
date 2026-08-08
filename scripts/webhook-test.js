#!/usr/bin/env node
// Week 6 Day 2 acceptance: bad signature → 400 with no state change; duplicate
// delivery → one state change; `succeeded` after `refunded` does not corrupt.
//
//   node scripts/webhook-test.js
// Requires booking service running with STRIPE_MODE=fake and
// STRIPE_WEBHOOK_SECRET matching WEBHOOK_SECRET below.

import { Client } from "pg";
import jwt from "jsonwebtoken";
import Stripe from "stripe";

const BASE = process.env.BASE || "http://localhost:3004";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_changeme";
const ADMISSION_SECRET = process.env.ADMISSION_TOKEN_SECRET || "changeme";
const admissionFor = (userId, eventId) =>
    jwt.sign({ eventId: String(eventId) }, ADMISSION_SECRET, { subject: String(userId), expiresIn: 900 });

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

// Signed with the real Stripe library, exactly as Stripe would — so a pass here
// means the endpoint accepts genuinely-valid signatures, not that it accepts
// whatever this script happens to produce.
let evtSeq = 1;
const sendWebhook = async (type, object, { eventId, badSignature = false } = {}) => {
    const payload = JSON.stringify({
        id: eventId ?? `evt_test_${evtSeq++}`,
        object: "event",
        type,
        data: { object },
    });
    const signature = badSignature
        ? "t=1700000000,v1=0000000000000000000000000000000000000000000000000000000000000000"
        : Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const res = await fetch(`${BASE}/webhooks/stripe`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        body: payload,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
};

const setup = async () => {
    const v = await db.query(`INSERT INTO venues (name,location,seat_map) VALUES ('WV','X','{}') RETURNING id`);
    const p = await db.query(`INSERT INTO performers (name) VALUES ('WP') RETURNING id`);
    const e = await db.query(
        `INSERT INTO events (name, venue_id, performer_id, event_date, max_tickets_per_user)
         VALUES ('Webhook Test', $1, $2, now() + interval '30 days', 10) RETURNING id`,
        [v.rows[0].id, p.rows[0].id]
    );
    const eventId = String(e.rows[0].id);
    const t = await db.query(
        `INSERT INTO tickets (event_id, seat, price)
         SELECT $1,'W'||g, 2000.00 FROM generate_series(1,4) g RETURNING id`, [eventId]);
    const u = await db.query(
        `INSERT INTO users (email,password_hash,role)
         SELECT 'wh-'||$1||'-'||g||'@t.in','x','user' FROM generate_series(1,3) g RETURNING id`, [eventId]);
    return { eventId, ticketIds: t.rows.map(r => String(r.id)), userIds: u.rows.map(r => String(r.id)) };
};

const bookedFixture = async () => {
    const s = await setup();
    const buyer = s.userIds[0];
    const r = await call("POST", "/bookings/confirm", {
        userId: buyer, admission: admissionFor(buyer, s.eventId),
        body: { eventId: s.eventId, ticketIds: s.ticketIds.slice(0, 2), paymentMethodId: "pm_test_visa" },
    });
    if (r.status !== 201) throw new Error(`fixture confirm failed: ${r.status} ${JSON.stringify(r.json)}`);
    return { ...s, buyer, bookingId: String(r.json.data.id) };
};

const paymentRow = async (bookingId) => {
    const { rows } = await db.query(`SELECT status, provider_ref FROM payments WHERE booking_id = $1`, [bookingId]);
    return rows[0];
};
const bookingRow = async (bookingId) => {
    const { rows } = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
    return rows[0];
};

const main = async () => {
    await db.connect();

    // ---- 1. bad signature -------------------------------------------------
    console.log("\n1. Bad signature → 400, zero state change");
    const f1 = await bookedFixture();
    const before = await paymentRow(f1.bookingId);

    const forged = await sendWebhook("charge.refunded",
        { id: "ch_forged", metadata: { bookingId: f1.bookingId } }, { badSignature: true });
    ok(forged.status === 400, "forged signature → 400", String(forged.status));

    const after = await paymentRow(f1.bookingId);
    ok(after.status === before.status, "payment status unchanged", `${before.status} → ${after.status}`);
    const ledger = await db.query(`SELECT count(*)::int c FROM webhook_events`);
    const bookingStill = await bookingRow(f1.bookingId);
    ok(bookingStill.status === "confirmed", "booking still confirmed", bookingStill.status);

    const missingSig = await fetch(`${BASE}/webhooks/stripe`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "evt_nosig", type: "charge.refunded", data: { object: {} } }),
    });
    ok(missingSig.status === 400, "missing stripe-signature header → 400", String(missingSig.status));

    // ---- 2. no auth, no rate limit needed ---------------------------------
    console.log("\n2. Endpoint is reachable without any auth header");
    ok(!forged.json?.error?.code?.includes("UNAUTHENTICATED"),
        "rejected on signature, not on a missing x-user-id",
        JSON.stringify(forged.json?.error?.code));

    // ---- 3. duplicate delivery -------------------------------------------
    console.log("\n3. Same event id twice → one state change");
    const f2 = await bookedFixture();
    const dupId = "evt_duplicate_1";
    const first = await sendWebhook("charge.refunded",
        { id: "ch_dup", metadata: { bookingId: f2.bookingId } }, { eventId: dupId });
    const second = await sendWebhook("charge.refunded",
        { id: "ch_dup", metadata: { bookingId: f2.bookingId } }, { eventId: dupId });

    ok(first.status === 200 && second.status === 200, "both deliveries acked with 2xx",
        `${first.status}/${second.status}`);
    ok(second.json?.outcome?.duplicate === true, "second is reported as a duplicate",
        JSON.stringify(second.json?.outcome));

    const dupLedger = await db.query(
        `SELECT count(*)::int c FROM webhook_events WHERE event_id = $1`, [dupId]);
    ok(dupLedger.rows[0].c === 1, "one ledger row for the event id", String(dupLedger.rows[0].c));

    const f2pay = await paymentRow(f2.bookingId);
    ok(f2pay.status === "refunded", "payment refunded exactly once", f2pay.status);
    const f2book = await bookingRow(f2.bookingId);
    ok(f2book.status === "refunded", "booking refunded", f2book.status);

    const f2seats = await db.query(
        `SELECT count(*)::int c FROM tickets WHERE id = ANY($1::bigint[]) AND status = 'available'`,
        [f2.ticketIds.slice(0, 2)]);
    ok(f2seats.rows[0].c === 2, "seats released once, not twice", `${f2seats.rows[0].c}/2`);

    // ---- 4. out-of-order: succeeded AFTER refunded ------------------------
    console.log("\n4. `succeeded` arriving after `refunded` does not corrupt");
    const late = await sendWebhook("payment_intent.succeeded",
        { id: f2pay.provider_ref, metadata: { bookingId: f2.bookingId } });
    ok(late.status === 200, "late event acked", String(late.status));

    const f2payAfter = await paymentRow(f2.bookingId);
    ok(f2payAfter.status === "refunded", "payment STILL refunded — not resurrected to succeeded",
        f2payAfter.status);
    const f2bookAfter = await bookingRow(f2.bookingId);
    ok(f2bookAfter.status === "refunded", "booking still refunded", f2bookAfter.status);
    ok(late.json?.outcome?.action === "already_terminal",
        "handler reports the transition was refused", JSON.stringify(late.json?.outcome));

    const f2seatsAfter = await db.query(
        `SELECT count(*)::int c FROM tickets WHERE id = ANY($1::bigint[]) AND status = 'available'`,
        [f2.ticketIds.slice(0, 2)]);
    ok(f2seatsAfter.rows[0].c === 2, "seats not re-booked by the late success",
        `${f2seatsAfter.rows[0].c}/2`);

    // ---- 5. webhook races the synchronous path ----------------------------
    console.log("\n5. Webhook and the sync confirm path reach the same terminal state");
    const f3 = await bookedFixture();
    const f3pay = await paymentRow(f3.bookingId);
    // The sync path already settled this. A `succeeded` webhook must be a no-op.
    const raced = await sendWebhook("payment_intent.succeeded",
        { id: f3pay.provider_ref, metadata: { bookingId: f3.bookingId } });
    ok(raced.status === 200, "acked", String(raced.status));
    ok(raced.json?.outcome?.action === "already_terminal", "no second settlement",
        JSON.stringify(raced.json?.outcome));
    const f3after = await paymentRow(f3.bookingId);
    ok(f3after.status === "succeeded", "still exactly 'succeeded'", f3after.status);

    // ---- 6. refund issued directly at the provider ------------------------
    console.log("\n6. Refund created in Stripe with no cancel on our side");
    const f4 = await bookedFixture();
    const refundEvt = await sendWebhook("charge.refunded",
        { id: "ch_dashboard", metadata: { bookingId: f4.bookingId } });
    ok(refundEvt.status === 200, "acked", String(refundEvt.status));
    const f4book = await bookingRow(f4.bookingId);
    ok(f4book.status === "refunded", "booking driven to refunded by the webhook alone", f4book.status);
    const f4seats = await db.query(
        `SELECT count(*)::int c FROM tickets WHERE id = ANY($1::bigint[]) AND status='available'`,
        [f4.ticketIds.slice(0, 2)]);
    ok(f4seats.rows[0].c === 2, "seats came back — not unsellable forever", `${f4seats.rows[0].c}/2`);

    // ---- 7. unroutable events are acked, not retried forever --------------
    console.log("\n7. Unknown / unroutable events");
    const noMeta = await sendWebhook("payment_intent.succeeded", { id: "pi_nometa" });
    ok(noMeta.status === 200, "event with no bookingId metadata is acked, not 400",
        String(noMeta.status));
    ok(noMeta.json?.outcome?.unrouted === true, "reported as unrouted",
        JSON.stringify(noMeta.json?.outcome));

    const unknown = await sendWebhook("customer.subscription.created",
        { id: "sub_1", metadata: { bookingId: f4.bookingId } });
    ok(unknown.status === 200, "unsubscribed event type acked", String(unknown.status));
    ok(unknown.json?.outcome?.ignored === true, "reported as ignored",
        JSON.stringify(unknown.json?.outcome));

    console.log(`\n${pass} passed, ${fail} failed\n`);
    await db.end();
    process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(1); });
