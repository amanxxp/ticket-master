# DECISIONS.md

Written defense of design choices. One entry per decision, with the alternative
considered and the failure each choice tolerates.

---

## Week 1 Day 3 — Booking concurrency defense

### 1. Isolation level for the confirm transaction

**READ COMMITTED** — Postgres' default, chosen deliberately rather than inherited.

The lost-update anomaly READ COMMITTED permits is real but does not reach us,
because the guard is a conditional `UPDATE` rather than a read-then-write. When
two transactions target the same row, the second blocks on the row lock, and on
release it **re-evaluates its `WHERE` clause against the winner's committed
version**. `status = 'available'` is then false, so it matches zero rows and the
rowcount check fails it. The dangerous read-modify-write interleaving never
exists, because the read and the write are one statement.

REPEATABLE READ would be actively worse here: the loser's re-evaluation would
instead raise `40001 could not serialize access due to concurrent update`, which
forces a client-side retry loop for a case we can already answer definitively
with a 409. SERIALIZABLE adds predicate locking and more serialization failures
to protect against phantoms that the confirm path never reads — it aggregates
nothing and scans no range.

Cost accepted: correctness depends on the CAS being expressed as a single
statement. A future refactor that splits it into `SELECT` then `UPDATE` silently
reintroduces the lost update. That is why the rowcount assertion exists as a
separate explicit check rather than being folded into the query.

### 2. Index used by the ticket lookup

`idx_tickets_event_status` on `tickets (event_id, status)` — already in
[db/schema.sql](db/schema.sql).

The confirm path's lookup is `WHERE id = ANY($1) AND event_id = $2`, which is
served by the **primary key** on `id`; the `ANY` becomes an index scan over at
most 20 ids, and `event_id` is a cheap filter on the fetched rows. The composite
index is not for this query.

It is justified by the seat-map read instead: `WHERE event_id = $1 AND status =
$2`, which is the hot public path and the one that scales with seat count. On a
50,000-ticket event, `(event_id, status)` turns "all available seats for this
event" into a contiguous range scan. Leading with `event_id` is required — the
reverse order, `(status, event_id)`, would put all events' available tickets in
one branch and force a filter, and a two-value column is a near-useless index
prefix.

Honest caveat: the column order means the index cannot serve a status-only query.
Nothing in the current design issues one.

### 3. Optimistic vs pessimistic under hot-event contention

**Optimistic (conditional `UPDATE` + rowcount) is the guard. Pessimistic
`FOR UPDATE` is used only to order lock acquisition, not to decide bookability.**

Under a hot event, the contended resource is a handful of rows with hundreds of
requests per second. Both approaches serialize at the row lock; the difference is
what happens to the losers. Pessimistic-as-guard makes every loser **wait** for
the winner's full transaction — including the `bookings` insert, the
`booking_items` insert, and the outbox write — before learning it lost. That
queues connections behind work whose outcome is already determined, and pool
exhaustion under load is a slower, more confusing failure than a 409.

Optimistic lets the loser fail on its own statement and release immediately. In a
ticketing system the loser's answer is genuinely final — the seat is gone, and
there is nothing to retry — so the cheap immediate rejection is the correct
shape. Optimistic concurrency is usually criticized for wasted work under high
contention, but that critique assumes a retry loop. Here there is none.

`FOR UPDATE` still earns its place for a different reason (see 3a).

### 3a. Why `ORDER BY id` on the lock, and why the lock at all

Two concurrent multi-ticket requests for `{A,B}` and `{B,A}` that locked in
arrival order would each hold one row and wait for the other. Postgres resolves
that by killing one with `40P01 deadlock detected` — correct, but it surfaces as
a hard error rather than a clean conflict, and it is load-dependent and
intermittent. `ORDER BY id FOR UPDATE` makes every transaction walk the rows in
the same direction, so the second one simply waits. Deadlock avoidance by
consistent lock ordering, not by retry.

The lock also lets the request distinguish **404 "no such ticket"** from **409
"already taken"**, and name exactly which seats failed. A bare CAS can only
report a count mismatch, which is a worse API.

`40P01` is still mapped to a retryable 409 rather than left to become a 500 —
if a future query plan reorders locks, that mapping keeps the failure honest
instead of hiding a lock-ordering regression behind a generic error.

### 4. Why `tickets.status` has no `held` value

A hold is a **lease** — a claim that expires on its own. Postgres has no native
row expiry, so `status = 'held'` would need a `held_until` column plus something
to sweep it. That creates two ways to be unavailable, and every availability
query would have to check both, correctly, forever. Worse, the sweeper becomes a
correctness dependency: if it stops, seats stay unbookable indefinitely, with
nothing in the schema to indicate they should not be. Redis expiry is the
mechanism the requirement wants, and it needs no sweeper (invariant 2 —
REQUIREMENTS.md line 214).

The deeper reason is ownership. `status` in Postgres records **settled fact**:
this seat is sold, money moved. A hold is unsettled intent. Mixing a
self-expiring optimistic claim into the column that also records a completed sale
means the durable record of what was sold is now written by the transient path.
Two writers, two lifetimes, one column.

Consequence accepted: effective availability is a **derived** value —
`booked` from Postgres, `held` from Redis, composed by one shared
`lib/availability` module used by both services. Redis loss then degrades
correctly: holds vanish, seats reopen, nothing sold twice, no confirmed booking
lost. Had `held` been in Postgres, a Redis outage would have left rows stuck in a
state nothing was left to clear.

### 5. Why ownership lives in `booking_items`, not `tickets.user_id`

`tickets.user_id` would be a **denormalized copy** of a fact that
`booking_items` → `bookings.user_id` already states. Two copies of one fact
drift, and the drift is silent: a cancel that clears `tickets.user_id` but leaves
`booking_items`, or the reverse, yields a ticket owned by nobody or by two
people, with no constraint able to notice.

The structural argument is stronger than the tidiness one. `UNIQUE (ticket_id)`
on `booking_items` **is** the third double-book guard — the database physically
refuses a second booking row for a ticket. A `user_id` column cannot express that:
`UPDATE tickets SET user_id = ...` overwrites, and overwriting is exactly the
double-book. Ownership as a row in a table with a unique constraint turns the
invariant into schema; ownership as a column makes it a convention that
application code must remember.

It also models reality: a booking is one purchase of several seats, with one
total and one status. `booking_items` is that relationship. `tickets.user_id`
loses which purchase a seat belonged to, and there is no place to put the total.

Cost accepted: "who owns this seat" is a join, not a column read. Cancellation
must **delete** the `booking_items` row rather than rely on `bookings.status`,
because the unique constraint would otherwise block resale of a cancelled seat
(REQUIREMENTS.md line 117) — the resale path is the reason, and the audit trail
lives in `bookings` and `outbox`, which are not deleted.

---

## Earlier decisions

### Soft vs hard delete on tickets

**Hard delete**, guarded by `status = 'available'` plus a `booking_items` check.

A ticket is inventory, not a record of intent — the intent lives in `bookings`
and `booking_items`, which are never hard-deleted. A soft flag would become a
*second* way for a seat to be unavailable, threaded through every availability
query alongside `status` and the Redis hold; invariant 3 wants that read cheap and
O(1), and a third state to check works against it. Sold tickets are never
reachable by the delete path, and `booking_items`' FK is the backstop.

Contrast with `events.is_deleted`, which **is** soft: an event is referenced by
sold tickets and past bookings, so its row must survive for history. A ticket that
was never sold has no history worth keeping.

---

## Week 2 Day 1 — Hold mechanism

### 6. Clock authority for hold expiry

**Redis' clock, read inside the Lua script via `redis.call('TIME')`.** No app
clock is ever compared to anything.

Two instances with skewed clocks would otherwise disagree about the same hold, and
whichever way the disagreement falls is a bug: the fast clock resells a live hold,
the slow one refuses a free seat. Reading `TIME` inside the script means the
expiry comparison and the write that follows it share a single clock reading from
a single machine — the skew has nowhere to enter. Verified across two Booking
Service instances configured with different TTLs, both agreeing on the same
hold's `expiresAt`.

Requires Redis ≥ 5 (effects replication), or a write after a non-deterministic
command is rejected. Running 7-alpine.

### 7. Expiry carried by a ZSET score, not a per-key TTL

Three structures per event, in `shared/availability.js`: a ZSET
(`member=ticketId, score=expiresAtMs`) for the bulk read, a HASH for ownership,
and a per-user ZSET for the cap.

The obvious design — one key per seat with `SET NX EX` — makes the *claim*
trivial and the *read* impossible: rendering a 50,000-seat map would be 50,000
`GET`s, and invariant 3 requires the round-trip count not to grow with seat count.
The ZSET turns the whole event into one `ZRANGEBYSCORE`.

The subtler gain is that **a score cannot expire silently.** A per-key TTL fires
no event a reader can observe, so an SSE design built on it either polls or
depends on keyspace notifications, which are fire-and-forget and drop on
disconnect. Filtering by score means an expired hold is never observable as live
in the first place — there is no window to miss. Memory is reclaimed by a lazy
purge plus a coarse container TTL refreshed on write; neither is a correctness
dependency, so a purge that never runs cannot resell a seat.

Cost accepted: the claim now spans three keys, so it needs a Lua script rather
than one atomic command, and all three keys must share a hash tag
(`hold:{evt:<id>}:…`) to live on one slot.

### 8. Why the per-user cap must be inside the script

`max_tickets_per_user` is checked in the same Lua as the claim. Split into
`ZCARD` then `ZADD`, two concurrent reserves both read `held = cap - 1`, both
pass, and the user ends up over cap — the check would exist and enforce nothing.
Verified: two concurrent 5-ticket reserves against a cap of 8 yield one 201 and
one 422, with 5 held, never 10.

The count spans both stores — confirmed tickets in Postgres, live holds in Redis —
because a cap that ignored either could be walked past by alternating confirm and
reserve. The Postgres half is read before the script, so a confirm landing in the
gap makes the count stale by at most one booking. Tolerated rather than fixed:
closing it means mirroring booked state into Redis, which gives the cap a second
source of truth. The confirm path enforces the cap independently, and that is
where an over-cap attempt is actually stopped.

### 9. Partial overlap with your own hold is rejected, not merged

Reserving `{A,B}` when you already hold `A` returns 409, not a merged hold.

`A` keeps its earlier expiry while `B` would get a later one, so "the hold" would
have two expiry times and no single honest answer for `expiresAt`. Release and
re-reserve is unambiguous. An exact retry of a set you already hold is the
idempotent case and returns the original `expiresAt` — retry must not extend a
hold, or a client looping on it holds inventory forever.

### 10. `holdId` is derived and unsigned

`base64url(JSON.stringify({e: eventId, t: ticketIds}))`.

A server-side id→hold mapping would be a second thing that can outlive the hold it
names. Deriving the id keeps Redis the only place hold state lives. Unsigned
because the id is a **locator, not a capability** — release re-checks ownership
against the owner hash inside the script, so forging an id for someone else's
seats returns 404. Signing would protect a secret the id does not carry.

Decoded ids are re-validated as strictly as a request body: the value is
attacker-controlled and reaches Lua `ARGV` and a `bigint[]` cast.

---

## Week 2 Day 2 — Seat map read (`GET /events/:id/seatmap`)

### 11. Which structure serves the read, and why per-key TTL can't

The `seats` ZSET from (7) — one `ZRANGEBYSCORE seats <now> +inf` returns every
live hold for the event in a single call, paired with one `HGETALL owner` for
who holds what. Two Redis round trips total, independent of ticket count; logged
and asserted by test (`assert.equal(calls, 2)` against 500 synthetic tickets).

A per-key-with-TTL design (`hold:evt:1:ticket:42`, `SET NX EX`) cannot serve this
read at all: there is no key naming this event's *set* of holds, so listing them
means either scanning the whole keyspace with `KEYS`/`SCAN` — unsafe on a live
instance, and still not O(1) — or issuing one `GET` per ticket, which is exactly
the per-seat round trip invariant 3 forbids. The ZSET is the read path; the
per-key design was never a candidate for it.

### 12. How the two structures avoid drifting

They don't get the chance to: `readLiveHolds(redisClient, eventId)` in
`shared/availability.js` is the **only** implementation that interprets the
ZSET+HASH pair as "who holds what, right now." Booking's diagnostic
`GET /bookings/holds/:eventId` and Event Service's `/seatmap` both call it —
neither re-derives the logic locally. (Booking's `hold.repository.js` originally
had its own copy; refactored to call the shared function once this endpoint
needed the same read, so there is now exactly one.) Day 3's SSE snapshot reuses
the same function for the same reason: a second implementation is how "expired
in the read path but live in the write path" bugs get introduced.

### 13. Booked beats held — enforced by check order, not by clearing the hold

A ticket's Postgres `status` is checked **first**; the Redis hold map is only
consulted when `status = 'available'`. This means `confirmBooking` (Week 1)
does not need to clear the Redis hold it's converting into a sale — and does
not. The stale entry sits in Redis until its own TTL/score lapses, but it is
never read, because `booked` already won upstream of that check. Cost: for the
few minutes until the score expires, `GET /bookings/holds/:eventId` (a diagnostic
endpoint, not the seat map) would still list the now-sold ticket as "held."
Accepted rather than fixed with an explicit release-on-confirm, since that would
add a Redis write to the booking-confirm hot path to correct a display-only
diagnostic.

### 14. `heldByMe` needs an identity the route doesn't require

The route is public (REQUIREMENTS.md: `GET /events/:id/seatmap ... public`), so
it cannot 401 on a missing identity the way `/bookings/confirm` does. Caller
identity is read from an optional `x-user-id` header: present → seats held by
that id are labeled `heldByMe: true`, held-by-anyone-else `false`; absent → every
held seat reads `heldByMe: false`, never `true` — a guest is never told a seat
is "theirs." Same header convention Booking already uses, so Week 4's gateway
swap (header → JWT subject) touches both services identically.

### 15. Zero writes to hold keys, verified

Event Service's Redis client (`services/event/config/redis.js`) only ever
reaches `zRangeByScoreWithScores` and `hGetAll`, both via `readLiveHolds`.
Verified two ways: `grep -rn "ZADD\|HSET\|EVAL" services/event` returns nothing,
and the test suite wraps the fake Redis client in a `Proxy` that throws on any
method call outside those two — a future edit that adds a write is a test
failure, not a design doc someone forgot to check.

---

## Week 2 Day 3 — SSE fan-out (`GET /events/:id/stream`)

### 16. Redis pub/sub, not an in-process `EventEmitter`

Two Event Service instances behind a load balancer must both deliver a reserve
that landed on neither of them — Booking Service publishes once, to Redis, and
every instance's own subscriber receives its own copy. An `EventEmitter` only
fans out within the process that emitted it; a reserve published on instance A
would never reach a client connected to instance B, and there is no way to
notice the gap from inside either instance. Verified: two SSE clients on
different hard-coded ports (simulating two instances against one Redis) both
receive one `reserve` from a third client's request.

### 17. One channel per event, not one global channel filtered per-message

`availability:event:<id>`, defined once in `shared/availability.js` and used
by both the publisher (Booking) and the subscriber (Event Service) —
`availabilityChannel`/`parseAvailabilityChannel`/`AVAILABILITY_CHANNEL_PATTERN`,
so neither side hardcodes the other's string.

A single global channel would mean every Event Service instance receives every
event's traffic and must inspect and discard the payloads it doesn't care
about — cost that scales with total platform activity, not with what that
instance's connected clients are watching. `PSUBSCRIBE availability:event:*`
lets Redis do the filtering at the pattern-match level; the handler still
receives every event's messages (Redis pub/sub has no per-instance interest
filtering below the channel/pattern given), but at least the *decision* of
which channels exist is centralized in the shared module, so channel naming
cannot drift between publisher and subscriber. The actual "does anyone here
care" check is `registry.hasClients(eventId)`, in-process, before any
Postgres/Redis read — that's what keeps per-message cost near zero for an
event with no local subscribers.

### 18. Delta payload carries ticketIds, not pre-rendered status

Booking publishes `{ type, ticketIds }` — the *fact* that something changed —
not `{ type, ticketIds, status: 'held', heldByMe: true }` or similar. It
cannot render `heldByMe`, because that depends on which viewer is asking, and
Booking has no idea which of N open SSE connections on Event Service will
receive this message or who is behind each one.

Event Service resolves the rendering per connected client: `getTicketDeltas`
reads Postgres + Redis for the named ticketIds once per incoming message
(not once per event, but not once per client either), then
`toSeatStatus(ticket, holds, viewerUserId)` — the exact function `/seatmap`
already uses — runs once per locally-connected client on that event. Same
function, so a push and a fresh snapshot can never disagree about what
`held`/`booked`/`available` means for the same underlying state.

### 19. Reconnect gets a full snapshot via `getSeatMap`, not partial replay

On connect (first time or after a drop), the stream immediately writes an
`event: snapshot` frame built by calling `seatmapService.getSeatMap` — the
identical function backing `GET /events/:id/seatmap`. No attempt is made to
replay messages missed while disconnected; pub/sub in Redis is fire-and-forget,
so there is nothing to replay from even if the code wanted to. A client that
was gone for 30 seconds does not need the 12 deltas it missed — it needs
correct *current* state, which one snapshot read already gives it in the same
2 Redis round trips + 1 Postgres read the seat map costs standing alone.

### 20. Publisher failure never fails the request it's about

`publishAvailabilityChange` swallows and logs; it is never awaited in a way
that can throw back into `confirmBooking`/`reserve`/`release`. A booking has
already committed to Postgres by the time it runs — failing to announce the
change over pub/sub cannot un-book the seat, so surfacing that failure to the
client as a booking error would misreport the actual outcome. Cost accepted:
open SSE streams learn about the change late (only at a client's next
reconnect snapshot) if Redis pub/sub itself is unreachable at the moment of
publish, rather than not at all — Postgres and the hold data Redis still holds
remain the source of truth throughout.

### 21. `EXISTING` (idempotent retry) does not publish; `CLAIMED` does

Reserve's idempotent-retry branch (double-click returns the same hold,
unchanged `expiresAt`) intentionally skips the publish — nothing in the store
moved, so telling every open stream "something changed" would be a false
signal solely because a client re-sent a request. Only a state transition —
`CLAIMED`, `RELEASED`, `confirm` succeeding — triggers a publish. Rejected
claims (`CONFLICT`/`OVERLAP`/`CAP_EXCEEDED`) and a rolled-back confirm publish
nothing for the same reason: no committed change happened.

### 22. Hold expiry is client-derived from `expiresAt`, not a server tick

No process emits a "this hold just expired" event at the moment a TTL lapses.
The client already has `expiresAt` from the snapshot or a prior delta and
computes "is this still held" locally against its own clock. A server tick
(a `setInterval` sweep publishing expiries) was rejected: it would need to
scan every event's holds on a schedule to find newly-expired ones, reintroducing
the sweeper-as-correctness-dependency problem (7) already rejected for the
write side, just relocated to the read side. Redis keyspace notifications were
also rejected, for the reason stated in `shared/availability.js`: they are
fire-and-forget per subscriber and drop silently across a disconnect, which is
exactly the gap an SSE reconnect-snapshot design cannot tolerate.

Cost accepted: a client with a badly skewed local clock can show a hold as live
a few seconds past or before the server's own view of `expiresAt`. Never a
correctness bug — Postgres and the Redis score are still the only things any
write path checks — only ever a momentary display discrepancy on the client
rendering the countdown.

---

## Still open

- **Why holds are in Redis and bookings are in Postgres** — argued in (4) and (7);
  still wants the one-line statement of which failure each store tolerates.
- **On cancel, does the `booking_items` row get deleted or does the unique
  constraint move?** — leaning delete, per the reasoning in (5); confirm when the
  cancel path is built (Week 5).
