# Ticket Master Server — Requirements & Build Spec

**Method:** You write every line of code, cold, timed. No AI-authored code. This doc = requirements + acceptance criteria only. It tells you *what* to build and *how you'll know it works* — never *how to write it*.

**Stack (locked):** Node + Express + PostgreSQL + Redis + Elasticsearch + Stripe (test mode).

**Golden rules (non-negotiable):**
1. AI never touches your editor. Paste finished code back for review only.
2. Every component: build blank-file, 35-min timer, no reference open.
3. Every component retested cold ≥2×, spaced 3–7 days apart.
4. Stuck 20 min → hand-write pseudocode, don't ask AI. Timer keeps running.
5. No copy-paste from this doc. Retype everything, including SQL.

---

## Target Architecture

```
Client ──> CDN ──> API Gateway ──┬──> Auth Service ────> PostgreSQL
                (authn/authz,    │
                 rate limit,     ├──> Search Service ──> Elasticsearch
                 routing,        │
                 correlation id) ├──> Event Service ───> Redis (event cache)
                                 │      · CRUD          └──> PostgreSQL
                                 │      · seat map
                                 │      · SSE stream <── Redis pub/sub
                                 │
                                 └──> Booking Service ──> Redis (ticket holds, queue)
                                        · reserve/confirm/cancel
                                        · admission gate    └──> PostgreSQL
                                        · queue + waitlist
                                        └──> Stripe
                                        └──> Redis pub/sub ──> Event Service SSE

           PostgreSQL ──(outbox poller)──> Elasticsearch
           Admitter (worker) ──> Redis queue
```

Four HTTP services + two workers. Gateway is the only public port.

**SSE lives on Event Service, not its own service.** Reasons: reconnect snapshot and live stream then share one implementation of effective-seat-status (two copies drift, and drift here shows a seat as available when it isn't). Cost accepted: an Event Service deploy drops every open stream, and a socket leak takes CRUD down with it. Keep the SSE handler in its own module with no imports from the CRUD layer so extraction later is a routing change.

**Hold-state ownership rule.** Booking Service is the **only writer** of hold keys. Event Service reads them. Both go through one shared `lib/availability` module — same code computes effective status on both sides. Never two implementations.

### Processes and ports

| Process | Port | Owns |
|---|---|---|
| Gateway | 3000 (only public) | authn/authz, rate limit, routing, timeouts, correlation IDs |
| Auth Service | 3001 | register, login, refresh, logout |
| Event Service | 3002 | events/venues/performers CRUD, event cache, seat map, SSE |
| Search Service | 3003 | Elasticsearch queries |
| Booking Service | 3004 | reserve, confirm, cancel, holds, queue, waitlist, Stripe |
| Outbox poller | — | worker, Postgres → ES |
| Admitter | — | worker, drains queue |

Workers have no inbound port. They still need their own crash-restart and graceful-shutdown paths — easy to forget until Week 5 Day 2 fails on lease release.

### Routing table (built Week 4)

```
POST   /auth/*                    -> Auth      3001   public
GET    /search                    -> Search    3003   public,  rate limited
GET    /events                    -> Event     3002   public
GET    /events/:id                -> Event     3002   public
GET    /events/:id/seatmap        -> Event     3002   public
GET    /events/:id/stream         -> Event     3002   public,  no buffering, no timeout
POST   /events                    -> Event     3002   auth + role
PUT    /events/:id                -> Event     3002   auth + role
DELETE /events/:id                -> Event     3002   auth + role
POST   /events/:id/waitlist       -> Booking   3004   auth
POST   /queue/join                -> Booking   3004   auth,    rate limited
GET    /queue/position            -> Booking   3004   auth
POST   /bookings/reserve          -> Booking   3004   auth,    rate limited, admission required
POST   /bookings/confirm          -> Booking   3004   auth,    rate limited, admission required
POST   /bookings/:id/cancel       -> Booking   3004   auth
POST   /webhooks/stripe           -> Booking   3004   NO auth, NO rate limit
```

Two rows that bite. The Stripe webhook carries no JWT, so it can't pass gateway auth, and rate-limiting it drops payment confirmations — its security is signature verification inside Booking Service. The SSE route needs response buffering off and the upstream timeout disabled, or it looks broken when the proxy is actually the problem.

---

## Domain Model

You write the DDL — types, constraints, FKs, indexes are your decisions to make and defend.

**events**
- `id, name, description, venue_id → venues, performer_id → performers, event_date, max_tickets_per_user, created_at, is_deleted`
- Decide: which columns get indexes? What does the list query filter and sort on?

**venues**
- `id, name, location, seat_map, created_at`
- `seat_map` is structural (sections/rows/capacity), not availability. Availability lives in `tickets`.

**performers**
- `id, name, created_at`

**users**
- `id, email, password_hash, role, created_at`
- `role ∈ {user, organizer, admin}`. Drives authz in Week 4.

**tickets**
- `id, event_id → events, seat, price, status, created_at`
- `status ∈ {available, booked}` — **only two values.** `held` is deliberately absent; holds live in Redis with a TTL. Write down why a third DB state would be wrong here.
- No `user_id` column. Ownership is derived from `booking_items` — one authoritative place, no denormalized copy to drift.
- Decide: composite index on `(event_id, status)`? Justify against the actual query.
- `UNIQUE (event_id, seat)`.

**bookings**
- `id, user_id → users, event_id → events, status, total_amount, created_at`
- `status ∈ {pending, confirmed, cancelled, refunded}`
- `total_amount` is computed server-side from `tickets.price`. Never accepted from the client.

**booking_items**
- `id, booking_id → bookings, ticket_id → tickets`
- **`UNIQUE (ticket_id)`** — the database itself refuses a second booking for a ticket. This is a third independent double-book guard, alongside the conditional `UPDATE` and the Redis hold. Cancellation must therefore delete the row or the constraint blocks resale — decide which and write it down.

**payments**
- `id, booking_id → bookings, provider_ref, idempotency_key, amount, status, created_at`
- `UNIQUE (idempotency_key)`.
- Row is written **before** calling Stripe. A crash must leave a `pending` row, never nothing.

**outbox**
- `id, aggregate_type, aggregate_id, payload, created_at, published_at`
- Written in the same transaction as the event/ticket change. Poller reads unpublished rows → Elasticsearch.

**Write-down before coding (1 line each, into `DECISIONS.md`):**
- Soft vs hard delete on tickets — which and why?
- Isolation level for the booking confirm transaction — which and why?
- Why holds are in Redis and bookings are in Postgres — state the failure each choice tolerates.
- On cancel, does `booking_items` row get deleted or does the unique constraint move? Justify.
- **Clock authority for hold expiry.** Two app instances with skewed clocks will disagree on whether a hold is expired. Name your single source of time and why.

---

## Invariants (must hold at every point in the build)

Correctness properties, not implementation instructions. Every week's tests check against them.

1. **No double-book, ever.** Two confirms for the same ticket → exactly one succeeds. Three independent guards: Redis hold (optimization), conditional `UPDATE` + rowcount (primary), `UNIQUE(ticket_id)` on `booking_items` (backstop). Removing any one must still leave the invariant true — test that.
2. **Redis loss is survivable.** Flush Redis mid-flight and the system stays correct: holds vanish, seats reopen, no seat sold twice, no confirmed booking lost.
3. **Seat-map read is O(1) round trips.** Cost of rendering availability must not grow with seat count. A 50-ticket event and a 50,000-ticket event take the same number of Redis calls.
4. **No booking is non-terminal.** Every booking reaches `confirmed`, `cancelled`, or `refunded`. A crash anywhere leaves work a sweeper can finish.
5. **Money is idempotent.** Same idempotency key twice → one charge. Retry after any crash is safe.
6. **Nothing reaches the booking path without admission.** Server-side check. Skipping the waiting-room UI by calling the API directly must fail.
7. **The client never supplies a price, an amount, or an identity.** All three are server-derived. A request that sends them has them ignored, not honored.
8. **Every log line carries a correlation ID** that traces one client request across all four services and both workers.

---

## Week 1 — Domain, CRUD, real concurrency

**Client ask:** "Users book tickets without double-booking under concurrent requests."

### Day 1 — DDL + CRUD, cold, 35 min
`POST/GET/PUT/DELETE/list` for `/events`, `/venues`, `/tickets`.

| Method | Path | Acceptance criteria |
|--------|------|--------------------|
| POST | /events | Validate required fields BEFORE DB write. 201 + created object. Missing field → 422. |
| GET | /events/:id | Found → 200 + object (venue + performer joined). Not found → 404, never `200 + null`. |
| PUT | /events/:id | Full replace. **Idempotent**: same body twice = same end state. |
| DELETE | /events/:id | Soft delete (`is_deleted=true`). Return 204 or 200 — pick one, be consistent. |
| GET | /events | Plain list for now (pagination is Week 3). |

**Cross-cutting (every endpoint, all weeks):**
- Error shape identical everywhere: `{ "error": { "code": "...", "message": "...", "correlationId": "..." } }`
- Status codes: 400 malformed / 401 unauthenticated / 403 unauthorized / 404 not found / 409 conflict / 422 validation / 429 rate-limited.
- Validation runs before touching DB. `try/catch` is NOT validation.

### Day 2 — Booking concurrency, cold, 35 min
`POST /bookings/confirm` such that two concurrent confirms for one ticket never both succeed.

- **DB-level guard**, not an in-memory lock (in-memory fails across instances).
- Pick pessimistic (`SELECT … FOR UPDATE`) or conditional-update-and-check-rowcount. Either is acceptable; you must be able to argue the one you chose.
- Multi-ticket bookings must be all-or-nothing.

**Acceptance tests (must pass):**
- 50 concurrent confirms at ONE ticket → exactly 1× 201, 49× 409. Zero double-books in DB.
- Multi-ticket: 2 concurrent requests for `{A,B}` and `{B,C}` → exactly one succeeds, and the loser leaves **no** partially-booked ticket.
- Opposite seat order → no deadlock. If you hit one, you learned why lock ordering matters.
- **Guard-removal test:** temporarily disable your conditional-update guard, rerun the 50-concurrent test. `UNIQUE(ticket_id)` must still hold the line — you should see 1× 201 and 49 constraint violations, not two bookings. Re-enable. This proves the backstop is real and not decorative.
- Written script that actually hammers it. "Looks fine" ≠ tested.

### Day 3 — Defend in writing
- Isolation level chosen + why.
- Index used by the ticket lookup + why.
- Optimistic vs pessimistic under hot-event contention — argue it.
- Why `tickets.status` has no `held` value.
- Why ownership lives in `booking_items` and not as a `tickets.user_id` column.

### Day 4 — Cold rebuild, 35 min, project closed
Rebuild the booking-confirm concurrency guard only. Blank file.

### Day 5 — Outreach + blockers log.

**Concepts:** ACID, isolation levels (READ COMMITTED / REPEATABLE READ / SERIALIZABLE), lost-update anomaly, row-level locking, pessimistic vs optimistic concurrency, compare-and-swap via conditional `UPDATE` + rowcount, unique constraints as concurrency guards, defense in depth, deadlock avoidance by consistent lock ordering, all-or-nothing multi-row writes, composite indexes, normalization vs denormalized ownership, soft delete + audit trail, idempotent PUT, validate-before-write.

---

## Week 2 — Holds in Redis + real-time seat map

**Client ask:** "A user picking seats blocks others for 10 minutes, and everyone watching sees it live."

### Day 1 — Hold, release, caps, cold, 35 min
`POST /bookings/reserve {eventId, ticketIds[]}` → hold with 10-min TTL. `DELETE /bookings/reserve/:id` → release.

**Acceptance criteria:**
- Two **different** users concurrently reserving the same ticket → exactly one 201, one 409. The claim must be atomic; a read-then-write loses this test.
- **Same user retrying is idempotent** — double-click returns the existing hold with its original `expiresAt`, not a 409 against themselves and not a refreshed TTL.
- Multi-ticket reserve is all-or-nothing. Asking for `{A,B}` when `B` is held must leave `A` **unheld** — verify `A` is still reservable immediately after.
- **Per-user cap enforced** via `events.max_tickets_per_user`. Existing holds plus confirmed tickets count toward it. Cap exceeded → 422 with the remaining allowance in the message. The check must be atomic with the claim, or two concurrent reserves both slip past it.
- Hold expires on its own after TTL. No cron, no sweeper. Ticket becomes reservable again.
- Response carries `expiresAt` as an absolute timestamp from your single clock authority.

### Day 2 — Seat map read, cold, 35 min
`GET /events/:id/seatmap` on **Event Service** → every ticket with effective status: `available` / `held` / `booked`. Read logic goes in `lib/availability`, shared with Day 3.

**Acceptance criteria:**
- **Redis round-trip count is constant regardless of seat count.** Log it, instrument it, assert it. An event with 50,000 tickets must not issue 50,000 lookups. This criterion is the entire day.
- Expired holds do not appear as held, even before anything cleans them up.
- Booked beats held. A ticket in `booking_items` never renders as merely held.
- A ticket held by *you* is labelled differently from one held by someone else — the client needs that distinction.
- Event Service performs **zero writes** to hold keys. Grep to confirm.
- Written note: which Redis structure serves the read path, why the per-key-with-TTL structure alone can't, and how you keep the two structures from drifting.

### Day 3 — SSE fan-out, cold, 35 min
`GET /events/:id/stream` on Event Service. Booking Service publishes reserve/release/confirm/cancel to Redis pub/sub; Event Service SSE handler subscribes and pushes.

**Acceptance criteria:**
- Two clients on one event; a reserve from a third client updates both within ~1s.
- Publisher does not block on delivery and does not know how many subscribers exist.
- **Two Event Service instances**: a reserve published by Booking Service reaches clients on *both* instances. In-process `EventEmitter` fails this — that's the lesson.
- Client reconnect gets a correct full snapshot from the same `lib/availability` code the stream uses, not a separate implementation.
- SSE handler imports nothing from the CRUD layer.
- Hold expiring by TTL: state the behavior you chose (client re-derives from `expiresAt`, or a tick emits) and why you didn't build on Redis keyspace notifications.
- Kill the Redis connection, restore it → subscriber reconnects and resumes without a process restart.

### Day 4 — Cold rebuild, 35 min
Rebuild the hold mechanism (Day 1) + the seat-map read path (Day 2). Blank file.

### Day 5 — Outreach + blockers log.

**Retest (spaced):** Week 1 booking guard, cold, ~10 min.

**Concepts:** distributed lock via `SET NX EX`, TTL-as-cleanup vs sweeper job, Lua scripts for multi-key atomicity, Redis hash tags / same-shard keys, sorted set as an expiry-ordered index, lazy purge, O(1)-round-trip read design, why per-key TTL and bulk-read are in tension, idempotent writes vs conflict, atomic read-check-write, per-user quota enforcement, clock authority and skew, pub/sub fan-out, at-most-once pub/sub delivery, subscriber reconnect, stateful SSE behind a stateless publisher, SSE vs WebSocket vs long-poll, snapshot-plus-delta reconnect, single-writer ownership of shared state, why keyspace notifications are unreliable.

---

## Week 3 — Pagination, cache, search + CDC

**Client ask:** "Listings must scale, search must be fuzzy and fast, event lookups can't hit the DB every time."

### Day 1 — Pagination, cold, 35 min
`GET /events` two ways: offset (`?page=&limit=`) and keyset (`?cursor=&limit=`).

**Acceptance criteria:**
- `limit=100000` → capped at 100, not OOM.
- Response carries next cursor / next-page indicator.
- Empty page → `200 + []`. Never 404.
- Sorting by `event_date` → cursor must be composite `(event_date, id)`. Written explanation of why a bare-`id` cursor returns wrong order.
- Written: why offset pagination skips and duplicates rows under concurrent insert.

### Day 2 — Event cache, cold, 35 min
Redis cache in front of `GET /events/:id`.

**Acceptance criteria:**
- Hit path measurably faster than DB path — log both.
- TTL set on every cached key.
- **Invalidation:** `PUT`/`DELETE` invalidates the key. Stale event data after an edit = fail.
- Cache only what's static. **The seat map must never be served from this cache** — write the boundary between the cacheable event body and live availability, and why crossing it is a correctness bug, not a staleness nit.
- Written: cache-aside vs write-through — which and why.

### Day 3 — Search Service + Elasticsearch, cold, 35 min
Separate process. `GET /search?term=&location=&type=&date=` → `Partial<Event>[]`.

**Acceptance criteria:**
- Index covers name, description, venue, performer, date.
- Fuzzy/partial: `"conc"` finds `"Concert"`; a one-character typo still matches.
- Multi-filter combines correctly: term + location + date range together.
- `term=""` → returns results, does not crash.
- No match → `200 + []`.
- Returns partial projections, not full events — client fetches detail from Event Service.
- Written: why this isn't `LIKE '%term%'` on Postgres, and what an inverted index actually does.

**Pre-work (do untimed, before the timer starts):** write and run one working ES index-and-query by hand. Learning the query DSL and the 35-min cold build are two different exercises; combining them guarantees an overrun.

### Day 4 — CDC via transactional outbox, cold, 35 min
Event write and outbox row in the **same transaction**; poller publishes to ES and marks rows published.

**Acceptance criteria:**
- Create an event → searchable, with no direct write from Event Service to Elasticsearch.
- Kill the poller mid-batch, restart → no lost events, no duplicate documents in ES (deterministic document IDs).
- **Elasticsearch down → event write to Postgres still succeeds.** Outbox drains once ES returns. Search staleness is acceptable; a failed write is not.
- Delete/soft-delete an event → removed from search results.
- Two poller instances running → no double-publish, no row processed twice.
- Written: 3 sentences comparing this to Debezium + Kafka. What Debezium gives you that a poller doesn't, and what it costs.

### Day 5 — Outreach + blockers log.

**Retest (spaced):** Week 2 hold mechanism, cold, ~10 min.

**Concepts:** offset vs keyset pagination, composite cursors, limit capping / resource exhaustion, cache-aside vs write-through, TTL, invalidation on write, cacheable-vs-live data boundary, inverted index, analyzers/tokenizers, fuzzy matching + edit distance, relevance scoring, query DSL, dual-write problem, transactional outbox, CDC, log-based replication (Debezium/WAL), at-least-once delivery + idempotent indexing, competing consumers / claim-a-row patterns, eventual consistency and acceptable staleness windows, read-model separation (CQRS-lite).

---

## Week 4 — API Gateway, auth, authz, rate limiting

**Client ask:** "One public entry point. Authenticated, authorized, throttled, traceable."

### Day 1 — Gateway routing, cold, 35 min
Reverse proxy + correlation IDs.

**Acceptance criteria:**
- Only the gateway port is publicly reachable. Service ports refuse external connections.
- **SSE proxies correctly** — streaming must not be buffered into one response, and the per-upstream timeout must not kill a long-lived stream. This will break first; fixing it is the lesson.
- Downstream service down → 503 in your error shape, not a hung request or a stack trace.
- Timeout per upstream. A hanging service must not hang the gateway.
- **Correlation ID** generated per request (or accepted from a trusted client), forwarded downstream as a header, present in every log line of every service and returned in every error body. Trace one request end-to-end across gateway → booking → pub/sub → SSE using only that ID.

### Day 2 — Auth Service, cold, 35 min
Register + login. Access token (JWT) + refresh token (opaque).

**Acceptance criteria:**
- Duplicate email → 409. Wrong password → 401.
- Password hashed with a slow KDF, never plaintext, never a fast hash.
- Login returns both tokens; JWT carries `role`.
- Wrong-password timing must not reveal whether the email exists — the KDF has to run either way.

### Day 3 — Gateway authn + authz, cold, 35 min
JWT verify, `X-User-Id` + `X-User-Role` injection, `/auth/refresh`, `/auth/logout`, role checks.

**Acceptance criteria:**
- Missing/expired/tampered token on a write → 401 at the gateway. Request never reaches the service.
- **Client-supplied `X-User-Id` / `X-User-Role` are stripped and overwritten.** A forged header must not become an identity or a privilege. Test both explicitly.
- `role=user` calling `POST /events` → **403, not 401.** Authenticated but unauthorized is a different answer, and interviewers ask.
- `/auth/refresh` issues a new access token. `/auth/logout` revokes the refresh token; a revoked token → 401.
- Written: services trust `X-User-Id` — state what has to be true about the network for that to be safe.

### Day 4 — Rate limiter, cold, 35 min
Sliding-window, per-user, Redis-backed, at the gateway, on search + booking.

**Acceptance criteria:**
- N per window per user. N+1th → 429 + `Retry-After`.
- Window actually slides. A fixed-bucket that resets hard on the boundary fails — know the difference and explain it.
- Two gateway instances share limiter state correctly.
- Increment + check is atomic. Concurrent requests must not both slip through on the same last slot.
- Keyed on the **injected** `userId`, so it runs after auth. Keying on IP throttles everyone behind one NAT — state why that's the wrong default.
- `POST /webhooks/stripe` is exempt from both auth and rate limiting. Its security is signature verification inside Booking Service. Write down why rate-limiting it would lose money.

### Day 5 — Outreach + blockers log.

**Retest (spaced):** Week 3 outbox poller, cold, ~10 min.

**Concepts:** API gateway pattern, reverse proxy, service isolation / network boundary, streaming through a proxy, per-upstream timeouts, circuit-breaking basics, correlation IDs / distributed tracing, structured logging, JWT structure + signature verification, access vs refresh tokens, token revocation and why stateless JWTs make it hard, password KDFs (bcrypt/argon2), timing attacks, authn vs authz, 401 vs 403, trusted-header injection and header stripping, confused-deputy problem, fixed-window vs sliding-window-log vs sliding-window-counter vs token bucket, atomic counters via Lua, distributed limiter state, `429` + `Retry-After`, load shedding vs queueing.

---

## Week 5 — Virtual waiting room, fairness, cancellation

**Client ask:** "1,000,000 users, 10,000 tickets. Nobody gets a 500. It has to feel fair. And people change their minds."

Three distinct features. Do not merge them.
- **Admission control** — bounds how many users are inside the booking flow at once.
- **Waitlist** — sold out, notify me if a ticket frees up.
- **Cancellation** — the thing that produces tickets for the waitlist.

### Day 1 — Queue join + position, cold, 35 min
`POST /queue/join {eventId}` → queue token + position. `GET /queue/position` → position + ETA.

**Acceptance criteria:**
- Position is **monotonic**: for any user, never increases across polls. A number that goes up destroys trust — treat it as a correctness bug.
- Queue token signed and bound to `userId + eventId`. Another user's or another event's token → 401. A copied token grants no second slot.
- Joining twice takes one slot.
- ETA derived from measured drain rate, not `position / assumed_rate`. Return a range, not false precision.

### Day 2 — Admitter + admission gate, cold, 35 min
Worker pops the queue and grants admission. Booking Service rejects anything without valid admission.

**Acceptance criteria:**
- Admit budget bounded by remaining inventory and active holds, not a fixed rate. Overbooking factor is config you can defend.
- `POST /bookings/reserve` without admission → **403 before any Redis or DB work.** Assert zero Redis calls on the reject path.
- **Two admitter processes running → still no over-admission.** Requires single-leader or fenced writes. This test is the day.
- Kill the admitter mid-drain, restart → queue resumes, no user stranded, no user admitted twice in a way that grants extra holds.
- **SIGTERM releases the leader lease** — restart resumes immediately instead of waiting for lease expiry.
- Hold expiry / release increases the admit budget. Steady state, the queue drains at the rate seats actually free.
- Inventory hits zero → remaining queue told sold-out and drained. Nobody waits 40 minutes for nothing.

### Day 3 — Fairness policy, cold, 35 min
Registration window, then randomized draw. `score = hash(userId, eventSeed)`, seed generated at sale-open.

**Acceptance criteria:**
- Position uncorrelated with join time. Prove it: 1000 registrants joining in sequence → run a correlation check, not an eyeball.
- Seed unguessable before sale-open, so nobody grinds for a good position.
- FIFO mode still available behind a flag, for comparison.
- Written: FIFO vs lottery vs weighted. Why pure FIFO selects for network latency and bots rather than fairness.

### Day 4 — Cancellation + waitlist, cold, 35 min
`POST /bookings/:id/cancel` → ticket returns to `available`, waitlist head notified. Refund is **stubbed** this week; Week 6 Day 1 wires the real one.

**Acceptance criteria:**
- Cancel releases every ticket in the booking, and each becomes reservable immediately — verify against the `UNIQUE(ticket_id)` constraint you chose to satisfy.
- Cancel publishes to pub/sub → open SSE clients see seats reopen live.
- Cancel is idempotent. Twice → one cancellation, one release, one notification.
- Cancel on an already-`cancelled` or already-`refunded` booking → 409, no state change.
- `POST /events/:id/waitlist` → released ticket notifies **exactly one** waitlist user with a bounded claim window. Unclaimed → next user. Claimed → removed from waitlist.
- Written: cancellation policy boundary — can a user cancel 5 minutes before the event? State the rule and where it's enforced.

### Day 5 — Load test + outreach
- 10,000 simulated queue joins → zero 500s, zero over-admission, and a written note on where the first bottleneck actually appeared.
- **Watch Postgres `max_connections` during this run.** 4 services + 2 workers + your load generator, each with a default pool, will exhaust the default 100. Record the actual connection count and your chosen pool sizes.
- Written: WebSocket vs SSE vs jittered long-poll for 1M waiting clients — pick one and cost it in connections per node.
- Blockers log.

**Retest (spaced):** Week 4 rate limiter, cold. Then state the difference between rate limiting and admission control in writing. Can't state it → you learned neither.

**Concepts:** virtual waiting room, admission control vs rate limiting, Redis sorted set as queue, leader election via lease, fencing tokens, split-brain over-admission, backpressure from downstream capacity, overbooking factor, queue-position monotonicity as a trust property, FIFO-is-not-fair, latency advantage, bot economics, per-user caps as bot mitigation, signed single-use tokens, graceful shutdown / lease release, thundering herd at sale-open, jitter, connection-count budgeting at 1M clients, connection-pool exhaustion, waitlist vs queue, claim windows, idempotent cancellation, state-machine guards on status transitions.

---

## Week 6 — Payment, failure modes, reconciliation

**Client ask:** "Never charge a customer who doesn't get a ticket. Never give away a ticket that wasn't paid for."

### Day 1 — Payment + real refund, cold, 35 min
`POST /bookings/confirm {ticketIds, paymentMethodId}` → Stripe → confirmed booking. Wire the real refund into Week 5's cancel.

**Acceptance criteria:**
- **`total_amount` computed server-side from `tickets.price`.** A request that includes an `amount` or `price` field has it ignored. Send a request claiming ₹1 for a ₹5000 ticket and verify the charge is ₹5000. Trusting a client amount is a free-tickets endpoint.
- `payments` row written **before** calling Stripe. Crash between the two leaves `pending`, never nothing.
- Idempotency key derived from `bookingId`. Same key twice → one charge. Verify in the Stripe dashboard, not just your logs.
- Confirm re-verifies the hold is still yours AND the ticket is still `available` in Postgres. Hold expired but Stripe charged → immediate refund + explicit error.
- Ticket flip, `booking_items` insert, and booking row all in one transaction.
- Cancel on a `confirmed` booking issues a real Stripe refund and lands on `refunded`, not `cancelled`. Two distinct terminal states — write down which applies when.

### Day 2 — Webhooks, cold, 35 min
Stripe webhook endpoint as a second path to confirmation.

**Acceptance criteria:**
- Signature verified. Unsigned or wrongly-signed payload → 400, no state change. **An unverified webhook endpoint is a free-tickets endpoint.**
- Same event delivered twice → one state change. Stripe retries; idempotency is mandatory.
- Out-of-order delivery (`succeeded` arriving after `refunded`) does not corrupt state. Guard on the status transition, not on arrival order.
- Webhook and the synchronous path race → same terminal state either way.
- Endpoint reachable without auth and without rate limiting, and that's deliberate — matches Week 4 Day 4.

### Day 3 — Failure injection drill, 35 min (no new build — break things)
Each scenario: **predict the outcome in writing first**, then run it.

| Injection | Required outcome |
|-----------|-----------------|
| Kill process between Stripe charge and DB confirm | Booking reaches terminal state via sweeper or webhook. Money and ticket agree. |
| Expire the hold mid-payment | Confirm fails cleanly, auto-refund, user re-admitted to the **front** of the queue — not the back. |
| `FLUSHALL` Redis mid-booking | Holds lost, seats reopen, zero double-books, zero lost confirmed bookings. |
| Redis down entirely | Reserve degrades or refuses cleanly. Confirm still works — Postgres is the arbiter. No 500 stack traces. |
| Elasticsearch down | Writes and bookings unaffected. Search degraded. Outbox drains on recovery. |
| Two Booking Service instances, same ticket, same instant | Exactly one 201. |
| Kill Postgres connection pool mid-request | Clean 503, no partial write, pool recovers without a restart. |
| SIGTERM during an in-flight confirm | Request completes or fully rolls back. No half-written booking. |

Every prediction you got wrong is the most valuable output of the week. Log them.

### Day 4 — Reconciler, cold, 35 min
Sweeper for `pending` payments + drift detector for Redis-vs-Postgres state.

**Acceptance criteria:**
- `pending` payments older than N minutes → queried against Stripe by idempotency key → driven to `confirmed` or `refunded`. Never left pending.
- Drift detector: ticket booked in Postgres but still held in Redis → hold cleared. Held in Redis with no live booking attempt → released.
- Every inconsistency injected on Day 3 is found and resolved by this sweep.
- Drift count emitted as a metric. Non-zero drift is a bug signal, not background noise.
- Safe to run concurrently with live traffic and safe to run twice.

### Day 5 — Recorded walkthrough + final log
Unscripted, no notes. Must cover:
1. **Three-layer double-book guard** — Redis hold, conditional `UPDATE`, `UNIQUE(ticket_id)`. What each stops, what happens when each fails.
2. Why holds live in Redis and money lives in Postgres.
3. Why the seat map costs the same at 50 seats and 50,000.
4. Dual-write problem and how the outbox solves it.
5. Why FIFO isn't fair.
6. Why `POST /webhooks/stripe` is the one endpoint with no auth and no rate limit.

Then: final blockers log, decide repeat vs extend.

**Concepts:** idempotency keys, write-intent-before-side-effect, exactly-once as at-least-once + idempotence, server-side amount derivation, webhook signature verification, replay and out-of-order webhook delivery, state-transition guards, terminal-state invariant, compensating transactions / refunds, saga basics, reconciliation loops, drift detection as a metric, graceful degradation, graceful shutdown, connection-pool failure handling, dual-store consistency (Redis fast path, Postgres truth), why Redis alone can't hold money (async replication loses writes on failover), Redlock and why it's skipped here, chaos/failure injection, predict-then-verify discipline.

---

## Optional Week 7 — Sharding

Only if Weeks 1–6 all cold-passed twice.

- Consistent hashing, standalone, cold. Even distribution across N nodes; adding a node moves ~1/N of keys, **measured**.
- Wire as event/ticket partitioning, same-day cold rebuild.
- Three questions answered unscripted: how much data moves on node join/leave, why virtual nodes, hot-partition handling.

**Deprioritized on purpose.** With this architecture the read bottleneck is Elasticsearch and the write bottleneck is per-event hold contention. Sharding by `event_id` addresses neither — a hot event is one shard no matter how many you have. Build it for interview recall, not because this system needs it. Be able to say exactly that.

---

## Scope Honesty

- Single-node Postgres, Redis, Elasticsearch. No replication, no failover. Multi-instance tests run multiple app processes locally, not across machines or partitions.
- **Shared database across services.** Event Service and Booking Service both read `tickets`. That's a shared-database split-by-process, not real service isolation — the data coupling remains, you've added network hops. Real boundaries mean a database per service, which turns the booking↔ticket write into a distributed transaction. Deliberate trade: you're learning gateways, isolation, and cross-service auth, not sagas. When asked "who owns the tickets table?", the honest answer is "shared, and that's the compromise I made."
- CDC is an outbox poller, not log-based replication. Debezium + Kafka is the production answer; you can describe it, not demo it.
- Stripe test mode, webhooks via local tunnel. Real provider partition behavior is not exercised.
- Pub/sub is at-most-once. A subscriber that's down misses the notification. You'll have built a durable queue — be ready to say why you'd swap it in for anything that matters.
- SSE on Event Service means an Event Service deploy drops every open stream. Accepted trade for a single availability implementation.
- **Bots.** Per-user caps and payment-instrument uniqueness are in scope. Nothing here stops an attacker holding 10,000 verified identities — that's identity verification, out of scope. Name it. It's the part real Ticketmaster still loses.

Say all of this plainly in interviews. Don't imply production scale.

## Open Item
**DSA maintenance** — still unallocated. Decide by Fri 2026-08-15: dead, or 2 problems/day cold as a separate track. Silence = it dies.
