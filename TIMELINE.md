# Ticket Master Server — Timeline & Schedule

**Shape:** 6 weeks × 5 days. No calendar dates — a "day" is one 35-min cold build, done when you do it.
**Method:** cold build, no AI code, 35-min timer per component, blank file, no reference open. Retest cold ≥2×, spaced ≥3 days.

**Daily block:** 1× 35-min cold build + 25 min test/debug + 15 min written defense = ~75 min. Day 5 each week = outreach + blockers log (no build), except Week 5 Day 5 (load test) and Week 6 Day 5 (walkthrough).

**Acceptance criteria live in `REQUIREMENTS.md`.** Read that day's section, close it, then start the timer.

---

## ▶ You are here

**Week 5, Day 3 — fairness: registration window + randomized draw.**

Done through Week 5 Day 2. `DECISIONS.md` runs to **#61**; its highest entry number is the reliable progress signal, not this marker.

| Week | Built |
|---|---|
| 1 | CRUD (event/venue/ticket), booking confirm, 3-layer double-book guard |
| 2 | Redis holds + cap, seat map, SSE fan-out via Redis pub/sub |
| 3 | Keyset + offset pagination, event cache, Elasticsearch, outbox CDC poller |
| 4 | Gateway proxy + policy table, auth (JWT + refresh), authz, sliding-window rate limiter, correlation IDs |
| 5 | Day 1 queue join + position · Day 2 admitter worker, leader lease, admission token |

**Day 3:** `score = hash(userId, eventSeed)`, seed generated at sale-open. Position must be uncorrelated with join time — prove it with a correlation check over 1000 sequential registrants, not by eye. Seed unguessable before open. Keep FIFO behind a flag for comparison.

Then Day 4 (cancel + waitlist) and Day 5 (10k-join load test) close Week 5.

Still open from earlier weeks, carried deliberately:
- ☐ `scripts/redis-counter.js` — Week 2 Day 2's round-trip criterion was never asserted with an instrumented counter
- ☐ no automated test suite is committed; verification has been throwaway scripts
- ☐ cold rebuilds (W1 D4, W2 D4) — check the retest ledger below before claiming a component learned

Move this marker down as you finish each day.

---

## Week 0 — Setup (untimed, no build)

| ✓ | Task | Done when |
|---|------|-----------|
| ✅ | Postgres + Redis + Elasticsearch reachable from Node | `SELECT 1`, `PING`, `_cluster/health` all return |
| ✅ | Schema — 9 tables | `db/schema.sql` applies clean |
| ✅ | Concurrency harness (N parallel requests, tallies status codes) | prints `{201: x, 409: y}` for any URL |
| ✅ | Seed script | one 50-ticket event + one 50,000-ticket event, one command |
| ✅ | Service skeletons — app.js, error middleware, routes, apiError | 5 services scaffolded |
| ☐ | `server.js` for gateway, event, search, booking | all 5 services start |
| ☐ | `/health` on every service | 200 from each |
| ☐ | JSON logger carrying `correlationId` | log lines are JSON with the field |
| ☐ | Migrations (versioned up/down, replaces raw schema.sql) | `up`/`down` both run |
| ☐ | Graceful shutdown helper | `kill -TERM` drains, closes pools, releases leases |
| ☐ | Explicit pool sizes per service | total budget written in `DECISIONS.md` |
| ☐ | Redis round-trip counter (wraps client, counts per request) | prints round-trip count per HTTP request |
| ✅ | `shared/availability.js` | key builders + expiry semantics + Lua helpers; imported by booking |
| ☐ | Stripe test account + local webhook tunnel | test event delivered to localhost |
| ✅ | `DECISIONS.md` — write-downs from REQUIREMENTS domain section | Week 1 Day 3 defense written; 3 items still open (2 are Week 2) |

Harness gates Week 1 Day 2. Counter gates Week 2 Day 2. Seed gates the 50k case. Pool sizes prevent a mystery failure in Week 5. Logger is cheap now and miserable to retrofit into 6 processes at Week 4.

---

## Week 1 — Domain, CRUD, real concurrency

| Day | Task | Time box | Done when |
|-----|------|----------|-----------|
| 1 | CRUD for `/events`, `/venues`, `/tickets` (DDL already done) | 35 min | missing field → 422 before DB write, not found → 404 never `200+null`, PUT idempotent, DELETE soft, one error shape everywhere |
| 2 | `POST /bookings/confirm` — DB-level guard, all-or-nothing multi-ticket | 35 min | 50 concurrent at one ticket → exactly 1× 201; guard-removal test proves `UNIQUE(ticket_id)` alone still blocks a double-book |
| 3 | Written defense: isolation level, index, optimistic vs pessimistic, no `held` status, ownership in `booking_items` | 30 min | 5 answers written, nothing open |
| 4 | Cold rebuild: booking-confirm guard only | 35 min | passes Day 2 harness, blank file |
| 5 | Outreach + blockers log. **Decide DSA track.** | — | log written, decision recorded |

---

## Week 2 — Holds in Redis + real-time seat map

Load-bearing week. If one week gets extra time, this one.

| Day | Task | Time box | Done when |
|-----|------|----------|-----------|
| 1 | `POST /bookings/reserve` — 10-min TTL hold, atomic claim, per-user cap, idempotent retry, release | 35 min | two users → 1× 201 / 1× 409; same user retry returns existing hold unchanged; cap check atomic with claim; hold self-expires, no sweeper |
| 2 | `GET /events/:id/seatmap` on Event Service, read logic in shared `availability` | 35 min | Redis round-trip count identical at 50 and 50,000 tickets, asserted; Event Service writes zero hold keys |
| 3 | `GET /events/:id/stream` — SSE + Redis pub/sub from Booking Service | 35 min | reserve on Booking Service reaches clients on **both** Event Service instances; reconnect snapshot uses same `availability` |
| 4 | Cold rebuild: hold mechanism + seat-map read path | 35 min | passes Day 1 + Day 2 tests including round-trip assertion |
| 5 | Outreach + blockers log | — | log written |

**Retest (spaced):** Week 1 booking guard, cold, ~10 min.
**Day 1 is overloaded.** Overrun → push the cap to Day 4. Never drop its atomicity.

---

## Week 3 — Pagination, cache, search + CDC

| Day | Task | Time box | Done when |
|-----|------|----------|-----------|
| 1 | `GET /events` offset + keyset pagination | 35 min | `limit=100000` capped at 100, next cursor returned, empty page → `200+[]`, composite `(event_date, id)` cursor justified in writing |
| 2 | Redis cache-aside on `GET /events/:id` + invalidation | 35 min | hit faster than DB (logged), TTL set, PUT/DELETE invalidates, seat map never served from this cache |
| 3 | Search Service + Elasticsearch index and query | 35 min | `"conc"` finds `"Concert"`, 1-char typo matches, term+location+date combine, no match → `200+[]` |
| 4 | Transactional outbox + poller → Elasticsearch | 35 min | ES down → event write still succeeds and drains on recovery; kill poller mid-batch → no loss, no dupes |
| 5 | Outreach + blockers log | — | log written |

**Retest (spaced):** Week 2 hold mechanism, cold, ~10 min.
**Day 3 pre-work (untimed, night before):** write and run one working ES index-and-query by hand.

---

## Week 4 — Gateway, auth, authz, rate limiting

| Day | Task | Time box | Done when |
|-----|------|----------|-----------|
| 1 | Gateway routing/proxy + correlation IDs | 35 min | service ports not public; SSE streams unbuffered and survives upstream timeout; one correlation ID traces gateway → booking → pub/sub → SSE |
| 2 | Auth Service: register + login, access JWT + opaque refresh | 35 min | dup email → 409, wrong password → 401, slow KDF, KDF runs for unknown emails too |
| 3 | Gateway authn + authz, `X-User-Id`/`X-User-Role` injection, refresh, logout | 35 min | tampered token → 401 at gateway; both client-sent identity headers stripped; `role=user` on `POST /events` → 403 not 401 |
| 4 | Sliding-window rate limiter at gateway, on search + booking | 35 min | N+1th → 429 + `Retry-After`, window slides, 2 instances share state, keyed on injected `userId`, Stripe webhook exempt |
| 5 | Outreach + blockers log | — | log written |

**Retest (spaced):** Week 3 outbox poller, cold, ~10 min.
**Day 1 is the most likely overrun in the plan.** SSE-through-proxy and correlation IDs both break here first.

---

## Week 5 — Waiting room, fairness, cancellation

| Day | Task | Time box | Done when |
|-----|------|----------|-----------|
| 1 | `POST /queue/join` + `GET /queue/position` | 35 min | position never increases across polls; token bound to `userId+eventId`, cross-user token → 401; ETA from measured drain rate |
| 2 | Admitter worker + admission gate | 35 min | reserve without admission → 403 with zero Redis calls; **two admitters → still no over-admission**; SIGTERM releases the lease |
| 3 | Fairness: registration window + randomized draw | 35 min | position/join-time correlation measured across 1000 registrants, not eyeballed; seed unguessable pre-open |
| 4 | `POST /bookings/:id/cancel` (refund stubbed) + waitlist | 35 min | cancel idempotent, releases all tickets, publishes to SSE; released ticket notifies exactly one waitlist user with a claim window |
| 5 | Load test + outreach + blockers log | 35 min | 10k joins → zero 500s, zero over-admission; actual Postgres connection count recorded vs `max_connections` |

**Retest (spaced):** Week 4 rate limiter, cold. Then write the difference between rate limiting and admission control.
**Cancel is here, not Week 6** — waitlist has no supply without it. Real Stripe refund lands Week 6 Day 1.

---

## Week 6 — Payment, failure modes, reconciliation

| Day | Task | Time box | Done when |
|-----|------|----------|-----------|
| 1 | Payment + real refund wired into Week 5's cancel | 35 min | request claiming ₹1 for a ₹5000 ticket still charges ₹5000; `payments` row written before Stripe call; same idempotency key → one charge |
| 2 | Stripe webhook as second confirmation path | 35 min | bad signature → 400 no state change; duplicate delivery → one state change; `succeeded` after `refunded` doesn't corrupt |
| 3 | Failure injection drill — predict in writing, then break it | 35 min | all 8 scenarios pass; every wrong prediction logged |
| 4 | Reconciler: pending-payment sweeper + Redis/Postgres drift detector | 35 min | every Day-3 inconsistency resolved; no booking left pending; drift emitted as a metric |
| 5 | Recorded unscripted walkthrough + final blockers log | 30 min | covers all 6 walkthrough points in REQUIREMENTS, no notes |

---

## Optional Week 7 — Sharding

Only if Weeks 1–6 all cold-passed twice.

| Day | Task | Time box | Done when |
|-----|------|----------|-----------|
| 1 | Consistent hashing, standalone | 35 min | even distribution across N nodes; node join moves ~1/N of keys, measured |
| 2 | Wire as event/ticket partitioning + same-day cold rebuild | 35 + 30 min | routing hits correct partition; rebuild passes Day 1 tests |
| 3 | Cold rebuild of weakest component across Weeks 1–6 | 35 min | passes its acceptance tests |
| 4 | Final log + decide repeat or extend | — | log written |

---

## Retest ledger (tick as you go)

| Component | Built | Retest 1 | Retest 2 |
|-----------|-------|----------|----------|
| CRUD + validation + error shape | ☐ | | |
| Booking confirm guard (3-layer) | ☐ | ☐ W1D4 | ☐ W2 |
| Redis hold (atomic, TTL, cap, idempotent) | ☐ | ☐ W2D4 | ☐ W3 |
| Seat-map read (constant round trips) | ☐ | ☐ W2D4 | |
| SSE + pub/sub fan-out | ☐ | | |
| Keyset pagination | ☐ | | |
| Event cache + invalidation | ☐ | | |
| Elasticsearch index + query | ☐ | | |
| Outbox + CDC poller | ☐ | ☐ W4 | |
| Gateway routing + correlation IDs | ☐ | | |
| Auth: register/login | ☐ | | |
| JWT verify / authz / refresh / logout | ☐ | | |
| Rate limiter (sliding window) | ☐ | ☐ W5 | |
| Queue join + position | ☐ | | |
| Admitter / admission control | ☐ | | |
| Fairness draw | ☐ | | |
| Cancellation + waitlist | ☐ | | |
| Payment idempotency + server-side amount | ☐ | | |
| Webhook handling | ☐ | | |
| Reconciler | ☐ | | |

**Rule:** component not cold-passed twice, spaced ≥3 days = not learned. Reschedule it into the next Day-5 slot.

**Single-pass going into Week 6:** SSE fan-out, Elasticsearch, gateway, auth, authz, all of Week 5. Not learned, by the rule above. Cost of 6 weeks instead of 8. Free slot → spend it on SSE fan-out and the admitter.
