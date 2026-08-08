#!/usr/bin/env node
// Week 6 Day 1 acceptance: server-derived amount, payments row before the charge,
// same idempotency key → one charge, real refund on cancel.
//
//   node scripts/payment-test.js
// Requires booking service running with STRIPE_MODE=fake.

import { Client } from "pg";
import jwt from "jsonwebtoken";

const BASE = process.env.BASE || "http://localhost:3004";
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

// Every ticket is ₹5000, so the "client claims ₹1" attack has an unambiguous
// expected charge.
const setup = async (price = "5000.00", count = 6) => {
    const v = await db.query(`INSERT INTO venues (name,location,seat_map) VALUES ('PV','X','{}') RETURNING id`);
    const p = await db.query(`INSERT INTO performers (name) VALUES ('PP') RETURNING id`);
    const e = await db.query(
        `INSERT INTO events (name, venue_id, performer_id, event_date, max_tickets_per_user)
         VALUES ('Payment Test', $1, $2, now() + interval '30 days', 10) RETURNING id`,
        [v.rows[0].id, p.rows[0].id]
    );
    const eventId = String(e.rows[0].id);
    const t = await db.query(
        `INSERT INTO tickets (event_id, seat, price)
         SELECT $1, 'P' || g, $2::numeric FROM generate_series(1,$3) g RETURNING id`,
        [eventId, price, count]
    );
    const u = await db.query(
        `INSERT INTO users (email, password_hash, role)
         SELECT 'pay-' || $1 || '-' || g || '@t.in','x','user' FROM generate_series(1,4) g RETURNING id`,
        [eventId]
    );
    return { eventId, ticketIds: t.rows.map((r) => String(r.id)), userIds: u.rows.map((r) => String(r.id)) };
};

const main = async () => {
    await db.connect();

    // ---- 1. the client cannot name the price ------------------------------
    console.log("\n1. Client-supplied amount is ignored — ₹1 claim on a ₹5000 ticket");
    const a = await setup();
    const buyer = a.userIds[0];
    const oneSeat = a.ticketIds.slice(0, 1);

    const lie = await call("POST", "/bookings/confirm", {
        userId: buyer,
        admission: admissionFor(buyer, a.eventId),
        body: {
            eventId: a.eventId, ticketIds: oneSeat,
            paymentMethodId: "pm_test_visa",
            amount: 1, price: 1, totalAmount: 1,
        },
    });
    ok(lie.status === 422, "a body carrying amount/price is rejected outright", String(lie.status));

    const honest = await call("POST", "/bookings/confirm", {
        userId: buyer,
        admission: admissionFor(buyer, a.eventId),
        body: { eventId: a.eventId, ticketIds: oneSeat, paymentMethodId: "pm_test_visa" },
    });
    ok(honest.status === 201, "clean confirm succeeds", `${honest.status} ${JSON.stringify(honest.json?.message)}`);

    const pay1 = await db.query(
        `SELECT amount::text, status, provider_ref, idempotency_key FROM payments WHERE booking_id = $1`,
        [honest.json.data.id]
    );
    ok(pay1.rows.length === 1, "exactly one payments row", String(pay1.rows.length));
    ok(pay1.rows[0].amount === "5000.00", "charged the ticket's real price, not the claimed ₹1",
        pay1.rows[0].amount);
    ok(pay1.rows[0].status === "succeeded", "payment settled", pay1.rows[0].status);
    ok(pay1.rows[0].idempotency_key === `booking:${honest.json.data.id}`,
        "idempotency key derived from the booking id", pay1.rows[0].idempotency_key);
    ok(pay1.rows[0].provider_ref?.startsWith("pi_"), "provider ref recorded", pay1.rows[0].provider_ref);

    const bk1 = await db.query(`SELECT status, total_amount::text FROM bookings WHERE id = $1`, [honest.json.data.id]);
    ok(bk1.rows[0].status === "confirmed", "booking promoted to confirmed", bk1.rows[0].status);
    ok(bk1.rows[0].total_amount === "5000.00", "booking total is server-derived", bk1.rows[0].total_amount);

    // ---- 2. multi-seat total ---------------------------------------------
    console.log("\n2. Multi-seat total is summed server-side");
    const twoSeats = a.ticketIds.slice(1, 3);
    const multi = await call("POST", "/bookings/confirm", {
        userId: buyer,
        admission: admissionFor(buyer, a.eventId),
        body: { eventId: a.eventId, ticketIds: twoSeats, paymentMethodId: "pm_test_visa" },
    });
    ok(multi.status === 201, "two-seat confirm succeeds", String(multi.status));
    const pay2 = await db.query(`SELECT amount::text FROM payments WHERE booking_id = $1`, [multi.json.data.id]);
    ok(pay2.rows[0].amount === "10000.00", "2 × ₹5000 = ₹10000", pay2.rows[0].amount);

    // ---- 3. payments row exists before the charge -------------------------
    console.log("\n3. Ordering: payments row is committed before the provider call");
    // Proven structurally: a declined card must still leave a payments row behind.
    // If the row were written after the charge, a decline would leave none.
    const b = await setup();
    const declBuyer = b.userIds[0];
    const declined = await call("POST", "/bookings/confirm", {
        userId: declBuyer,
        admission: admissionFor(declBuyer, b.eventId),
        body: { eventId: b.eventId, ticketIds: b.ticketIds.slice(0, 2), paymentMethodId: "pm_fail_card" },
    });
    ok(declined.status === 402, "declined card → 402", String(declined.status));

    const declRows = await db.query(
        `SELECT p.status AS pstatus, b.status AS bstatus
         FROM payments p JOIN bookings b ON b.id = p.booking_id
         WHERE b.event_id = $1`,
        [b.eventId]
    );
    ok(declRows.rows.length === 1, "a payments row survives the decline — it was written first",
        String(declRows.rows.length));
    ok(declRows.rows[0].pstatus === "failed", "payment marked failed", declRows.rows[0].pstatus);
    ok(declRows.rows[0].bstatus === "cancelled", "booking driven to a terminal state, not left pending",
        declRows.rows[0].bstatus);

    const freed = await db.query(
        `SELECT count(*)::int c FROM tickets WHERE id = ANY($1::bigint[]) AND status = 'available'`,
        [b.ticketIds.slice(0, 2)]
    );
    ok(freed.rows[0].c === 2, "seats released by the compensating transaction", `${freed.rows[0].c}/2`);

    const resell = await call("POST", "/bookings/confirm", {
        userId: b.userIds[1],
        admission: admissionFor(b.userIds[1], b.eventId),
        body: { eventId: b.eventId, ticketIds: b.ticketIds.slice(0, 2), paymentMethodId: "pm_test_visa" },
    });
    ok(resell.status === 201, "another buyer can take the released seats", String(resell.status));

    // ---- 4. same idempotency key → one charge -----------------------------
    console.log("\n4. Same idempotency key charges once");
    const c = await setup();
    const cBuyer = c.userIds[0];
    const seat = c.ticketIds.slice(0, 1);

    const [r1, r2] = await Promise.all([
        call("POST", "/bookings/confirm", {
            userId: cBuyer, admission: admissionFor(cBuyer, c.eventId),
            body: { eventId: c.eventId, ticketIds: seat, paymentMethodId: "pm_test_visa" },
        }),
        call("POST", "/bookings/confirm", {
            userId: cBuyer, admission: admissionFor(cBuyer, c.eventId),
            body: { eventId: c.eventId, ticketIds: seat, paymentMethodId: "pm_test_visa" },
        }),
    ]);
    const codes = [r1.status, r2.status].sort();
    ok(codes[0] === 201 && codes[1] === 409, "concurrent confirms → one 201, one 409", JSON.stringify(codes));

    const charged = await db.query(
        `SELECT count(*)::int c FROM payments p JOIN bookings b ON b.id = p.booking_id
         WHERE b.event_id = $1 AND p.status = 'succeeded'`,
        [c.eventId]
    );
    ok(charged.rows[0].c === 1, "exactly one successful charge for the contested seat",
        String(charged.rows[0].c));

    // ---- 5. refund on cancel ---------------------------------------------
    console.log("\n5. Cancel issues a real refund and lands on 'refunded'");
    const d = await setup();
    const dBuyer = d.userIds[0];
    const booked = await call("POST", "/bookings/confirm", {
        userId: dBuyer, admission: admissionFor(dBuyer, d.eventId),
        body: { eventId: d.eventId, ticketIds: d.ticketIds.slice(0, 2), paymentMethodId: "pm_test_visa" },
    });
    ok(booked.status === 201, "booked", String(booked.status));

    const cancelled = await call("POST", `/bookings/${booked.json.data.id}/cancel`, { userId: dBuyer });
    ok(cancelled.status === 200, "cancel returns 200", String(cancelled.status));
    ok(cancelled.json?.data?.status === "refunded", "booking status 'refunded'", cancelled.json?.data?.status);
    ok(cancelled.json?.data?.refund?.refundId?.startsWith("re_"),
        "a refund id came back from the provider", JSON.stringify(cancelled.json?.data?.refund));
    ok(cancelled.json?.data?.refund?.amount === "10000.00",
        "refund is the full server-derived total", String(cancelled.json?.data?.refund?.amount));

    const payAfter = await db.query(`SELECT status FROM payments WHERE booking_id = $1`, [booked.json.data.id]);
    ok(payAfter.rows[0].status === "refunded", "payments row marked refunded", payAfter.rows[0].status);

    // ---- 6. no double refund ---------------------------------------------
    console.log("\n6. A second cancel refunds nothing");
    const again = await call("POST", `/bookings/${booked.json.data.id}/cancel`, { userId: dBuyer });
    ok(again.status === 409, "second cancel → 409", String(again.status));
    const payFinal = await db.query(
        `SELECT status, count(*)::int c FROM payments WHERE booking_id = $1 GROUP BY status`,
        [booked.json.data.id]
    );
    ok(payFinal.rows.length === 1 && payFinal.rows[0].status === "refunded",
        "still exactly one payment, still 'refunded'", JSON.stringify(payFinal.rows));

    // ---- 7. paymentMethodId is mandatory ---------------------------------
    console.log("\n7. Confirm without a payment method");
    const e2 = await setup();
    const noPm = await call("POST", "/bookings/confirm", {
        userId: e2.userIds[0], admission: admissionFor(e2.userIds[0], e2.eventId),
        body: { eventId: e2.eventId, ticketIds: e2.ticketIds.slice(0, 1) },
    });
    ok(noPm.status === 422, "missing paymentMethodId → 422, no free tickets", String(noPm.status));
    const noRows = await db.query(`SELECT count(*)::int c FROM bookings WHERE event_id = $1`, [e2.eventId]);
    ok(noRows.rows[0].c === 0, "no booking created", String(noRows.rows[0].c));

    console.log(`\n${pass} passed, ${fail} failed\n`);
    await db.end();
    process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(1); });
