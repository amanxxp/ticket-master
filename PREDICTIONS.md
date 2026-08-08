# Week 6 Day 3 — Failure injection predictions

**Fill this in BEFORE running `node scripts/failure-injection.js`.** The value of
this exercise is entirely in the gap between what you expect and what happens; a
prediction written after seeing the result is worth nothing.

For each scenario write, in one or two lines:
- what state Postgres ends in
- what state Redis ends in
- what the customer sees
- whether the seats are sellable afterwards, and who by

Then run the harness, and record every prediction you got wrong at the bottom.
Those are the most valuable output of the entire six weeks.

---

## 1. Kill the process between the Stripe charge and the DB confirm

`BOOKING_CRASH_AFTER_CHARGE=true` — the charge succeeds, then the process exits
before the payment is settled or the booking promoted.

**Prediction:**

---

## 2. Hold expires mid-payment

The hold's TTL lapses between reserve and confirm.

**Prediction:**

---

## 3. `FLUSHALL` Redis mid-booking

Every hold, queue, and admission record vanishes while a booking is in flight.

**Prediction:**

---

## 4. Redis down entirely

Reserve, seat map, and confirm attempted with no Redis at all.

**Prediction:**

---

## 5. Elasticsearch down

Event writes and bookings attempted with ES unreachable.

**Prediction:**

---

## 6. Two Booking Service instances, same ticket, same instant

**Prediction:**

---

## 7. Postgres connection killed mid-request

**Prediction:**

---

## 8. SIGTERM during an in-flight confirm

**Prediction:**

---

# Wrong predictions

Record what surprised you. One line each: what you expected, what happened, and
what you now understand that you did not before.

| # | Expected | Actual | What it taught |
|---|----------|--------|----------------|
|   |          |        |                |
