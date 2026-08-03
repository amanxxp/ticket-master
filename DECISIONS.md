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

## Week 3 Day 1 — Pagination (`GET /events`)

### 23. Why a bare-`id` keyset cursor returns the wrong order

The list sorts `ORDER BY event_date ASC, id ASC`. `id` and `event_date` are
independent — an event created later can carry an earlier `event_date` than one
created before it (a venue backfilling next month's schedule, say). A cursor
that filters `id > lastId` walks *insertion* order, not *display* order, and
the two only coincide by accident.

Concretely: event A (`id=5`, date Jan 10) is shown, cursor becomes `id=5`. Event
B (`id=3`, date Jan 12) sorts *after* A by date but has a smaller id —
`id > 5` excludes it, so it never appears; the client's "next page" silently
skips a row that belongs there. The reverse also happens: event C (`id=9`, date
Jan 1) sorts *before* A but has a larger id — `id > 5` includes it again on a
later page, so a row already shown reappears.

The fix is filtering on the actual sort key, tie-broken by id for the rows that
share a date: `(event_date, id) > (lastDate, lastId)`. This is a single
row-comparison predicate, which Postgres can serve as one range scan on
`idx_events_date_active (event_date, id)` — not two independent filters
OR'd together, which would force a filter step instead of a scan.

### 24. Why offset pagination skips and duplicates rows under concurrent insert

`LIMIT/OFFSET` has no memory of what it showed last — it re-runs the full
ordered scan from row 0 every call and just discards the first `OFFSET` rows.
The window is defined by *position*, not by any value in the data.

If a new event is inserted with an `event_date` earlier than everything already
paged through, every row after it shifts one position to the right. A client
that fetched page 1 (`OFFSET 0`) and is about to fetch page 2 (`OFFSET 10`) now
gets, at `OFFSET 10`, the row that used to be at position 9 — the last row of
page 1, **duplicated**. Symmetrically, a delete ahead of the window shifts
everything left, and the row that used to be first on page 2 is now at position
9, on a page the client already fetched — it never appears, **skipped**.

Keyset pagination doesn't have this failure mode because its cursor is an
actual value from the data (`(event_date, id)` of the last row seen), not a
position — a row inserted anywhere except immediately after that value cannot
move where the cursor points.

Offset mode is kept anyway (`?page=&limit=`) because it answers a question
keyset can't: "jump to page 7," a UI a keyset cursor cannot support since
skipping forward without walking every intermediate cursor is not something
keyset was designed to do. It's the right tool for a bounded, human-paged admin
list; the wrong one for the primary "browse upcoming events" feed, which
defaults to keyset for exactly this reason.

### 25. `limit` is clamped, not rejected

`limit=100000` returns `limit: 100` in the response, not a 422. A silent cap
protects the same resource — an unbounded `LIMIT` materializing rows without
end — that a rejection would, but a reject forces every client integration to
handle "my request for `limit=100000` needs a retry with a smaller number,"
which is a worse contract for a value that has one obviously correct fallback
(the max). Genuinely invalid values (`limit=0`, `limit=-1`, non-integers) still
422 — only the *upper* bound is soft.

---

## Week 3 Day 2 — Event cache (`GET /events/:id`)

### 26. Cache-aside, not write-through

Read path checks Redis first, falls through to Postgres on a miss, populates
Redis for next time (`services/event.service.js#getEvent`). Write path
(`editEvent`/`removeEvent`) invalidates the key rather than writing the new
value into the cache directly.

Write-through would mean every `PUT`/`DELETE` computes and writes the
post-update cache entry as part of the request — extra work on a path that
already has more to do (guards, the outbox insert, the transaction commit),
for a value nobody may read again before its TTL would have expired anyway.
Invalidate-and-let-the-next-reader-repopulate is cheaper and just as correct:
the next `GET` after an edit is a guaranteed miss, which is exactly the
guarantee needed — a stale hit is the failure being prevented, and an
invalidated key cannot serve one.

### 27. The seat map must never be served from this cache — it never even reaches it

Not a defensive check the code has to enforce (there is no
`if (path === '/seatmap') skipCache()` anywhere) — it's true by construction.
`getEventById`'s projection (`services/event/repositories/event.repository.js`)
was scoped, back in Week 1, to `id, name, description, venueId, performerId,
eventDate, maxTicketsPerUser, createdAt` plus the joined venue/performer —
deliberately excluding `seat_map` and never touching Redis hold state at all.
The cache in front of it (`eventCache.repository.js`) can only ever hold what
that query returns, which is the static event body — nothing live is in the
value being cached, so there is no live value the cache could accidentally
serve.

`GET /events/:id/seatmap` is a completely separate code path
(`seatmap.service.js`) that reads current ticket status from Postgres and
current holds from Redis on **every call**, with no cache in front of it at
all. The boundary is: *the event's own facts* (name, date, venue) are
cacheable because only an explicit edit changes them, and an edit already
invalidates the key; *availability* (booked/held/available per ticket) changes
on every reserve/release/confirm — a rate no TTL could track — so it is
recomputed fresh, always.

Crossing this boundary — caching a seat map, or adding `seat_map`/ticket
status into the cached event body — would not be a staleness nit tunable by a
shorter TTL. A booked seat rendering as available for even one TTL window is
the double-book invariant's failure mode reached through the read side instead
of the write side: nothing downstream re-checks a `GET` response before a
client acts on it, so a stale "available" is indistinguishable from a real one
until the booking attempt itself fails.

---

## Week 3 Day 3 — Search Service + Elasticsearch

### 28. Why not `LIKE '%term%'` on Postgres — what an inverted index actually does

`LIKE '%term%'` has a leading wildcard, which means Postgres cannot use a
B-tree index to jump to matching rows — a B-tree is ordered by prefix, and
"contains this substring anywhere" isn't a prefix condition, so the only plan
available is a sequential scan comparing the pattern against every row's text.
Cost scales with table size, not with how selective the search is. It also has
no fuzziness (a search for "Cocnert" simply does not match "Concert" — an exact
substring engine has no notion of edit distance) and no relevance ranking (a
row either contains the substring or it doesn't; there is no way to say one
match is a better match than another).

An inverted index flips the relationship: instead of "for each row, does it
contain the term," it stores "for each term, which rows contain it" — a
term → postings-list map built once at index time. A query becomes a lookup
into that map, not a scan of every document. Elasticsearch's edge-ngram
analyzer (`shared/searchIndex.js`) extends this by indexing every prefix of a
token as its own term, so "conc" is a real dictionary entry pointing directly
at "Concert" documents — no scan, no substring search, just another lookup.
Fuzzy matching (`fuzziness: AUTO` at query time) adds edit-distance tolerance on
top of the same term-lookup structure, which a `LIKE` scan has no equivalent
of at any cost.

### 29. Two matching mechanisms for two different acceptance criteria

"`conc` finds `Concert`" and "a one-character typo still matches" are not the
same problem and one mechanism does not solve both. Prefix matching
("`conc`" → "Concert") needs the query term to already exist as an indexed
unit — solved by the edge-ngram `.autocomplete` subfield, queried *without*
fuzziness (the prefix is already a literal indexed term; adding fuzzy matching
on top of an ngram field would explode the candidate set for no benefit,
since near-misses of a 4-character ngram fragment are mostly noise). Typo
tolerance needs edit-distance comparison against the *whole* term — solved by
`fuzziness: AUTO` on the plain analyzed field, which the ngram field cannot
give for free (ngram-ing "Cocnert" produces a completely different set of
fragments than ngram-ing "Concert").

`search.service.js` runs both as `should` clauses under one `bool` query
(`minimum_should_match: 1`) rather than picking one — a real user query can
need either, and there's no way to tell in advance which one a given term is.

### 30. Multi-filter is one `bool.must`, each filter independently optional

`term`, `location`, `date` each contribute a clause only when present
(`termClause`/`locationClause`/`dateClause` all return `null` on an absent
param, filtered out before the query is built) — an absent `bool.must` entirely
falls back to `match_all`. This is what makes "term + location + date range
together" and "`term=''` still returns results" both true from the same code
path: there is no special-cased "if only term" vs "if term and location"
branching to keep in sync: `must.length` is just however many of the three
filters happened to be present.

### 31. `type` is accepted but not applied — no domain field backs it

The events table (`db/schema.sql`) has no category/type column anywhere in the
domain model, and REQUIREMENTS.md's Domain Model section never introduces one.
Rather than filtering against a fabricated field (which would either silently
match nothing whenever `type` is passed, or worse, guess at mapping it onto
some other column and produce a wrong-but-plausible-looking result), the
validator accepts `type` without erroring — a client sending it does not 422 —
but `search.service.js` never reads it. This is a real gap, not a completed
feature: adding a genuine `type`/category concept to `events` is a schema
decision for whoever owns that domain model change, not something to invent
silently inside the search layer.

---

## Week 3 Day 4 — Transactional outbox + poller → Elasticsearch

### 32. Three sentences on Debezium + Kafka vs. this poller

Debezium reads Postgres's write-ahead log directly (log-based CDC), so it
captures every change with sub-second latency and zero extra write inside the
application's own transaction, and it needs no outbox table at all since it
decodes INSERT/UPDATE/DELETE straight from the replication stream. This
poller instead requires an explicit outbox row written inside every business
transaction (one extra insert per write) and finds changes by periodically
scanning that table, trading near-real-time delivery for a polling delay
(`OUTBOX_POLL_INTERVAL_MS`) and a discipline every future writer must follow
correctly by hand. What Debezium costs in return: a Kafka Connect cluster (or
standalone Debezium server) to operate, a replication slot on Postgres whose
WAL can bloat if a consumer falls behind, and materially more infrastructure
than one Node process running a SQL query in a loop.

### 33. `FOR UPDATE SKIP LOCKED` is the competing-consumers guard

Two poller instances running the identical claim query at the same moment
each lock a disjoint set of outbox rows: whatever instance A already holds
`FOR UPDATE`, instance B's `SKIP LOCKED` excludes from its own result set
outright, rather than blocking behind A's lock waiting for it to release.
Neither instance ever waits on the other, and — because the row sets they
claim are disjoint by construction — no row is ever processed by both. This
is the entire mechanism behind "two poller instances running → no
double-publish, no row processed twice"; nothing else coordinates between the
two processes, and nothing else needs to.

### 34. Deterministic document IDs are what makes at-least-once delivery safe

The ES document `_id` is the event's own Postgres id (`searchDocId`), not an
autogenerated one. This is the whole reason "kill the poller mid-batch,
restart → no duplicate documents" is achievable without any de-duplication
logic: if the process dies before `COMMIT`, Postgres rolls back the entire
open transaction, so none of that batch's rows got marked `published_at`, and
their locks release for the next attempt to reclaim. That next attempt
re-indexes the same events — but "index with `_id: 7`" is a PUT, and a second
PUT with the same id overwrites the first rather than creating a second
document. At-least-once delivery is only safe to build when the operation it
retries is idempotent; a deterministic id is what makes indexing idempotent
here.

### 35. Per-row apply-and-mark inside one open transaction, not one batch-level commit

Each claimed row is applied to Elasticsearch and marked published individually,
still inside the single transaction the whole batch runs in — not applied in
memory first and marked with one final bulk `UPDATE`. This matters for the two
failure modes the acceptance criteria name separately:
- **Elasticsearch down:** every row in the batch fails identically, none get
  marked, and the transaction still commits — harmlessly, since committing zero
  `UPDATE`s changes nothing. The rows stay claimed-but-unpublished and are
  reclaimed on the next tick. The original Postgres write this poller is
  draining was never in question — it already committed, independently, before
  this poller ever saw the row — so "ES down → event write to Postgres still
  succeeds" is true by construction, not something this poller has to arrange.
- **One malformed row among many healthy ones:** only that row's `try/catch`
  catches the failure; the rows around it that succeeded keep their individual
  `UPDATE`s, which the shared `COMMIT` then persists. A batch-level
  catch-and-rollback would have thrown away every good write in the batch to
  protect against one bad one.

### 36. Delete is a real ES delete, not a soft `isDeleted` flag on the document

`event.deleted` triggers `esClient.delete`, removing the document outright.
Flagging it instead (`isDeleted: true` + filtering every query) would need
every future query — including ones nobody has written yet — to remember to
add that filter, and a query that forgets it silently returns a deleted event.
A hard delete makes "removed from search results" true of every possible
query with nothing to remember; there is also no legitimate reason to search
for a deleted event through this index; whoever needs that Postgres's own
`is_deleted` column already carries it.

---

## Week 4 Day 1 — Gateway routing/proxy + correlation IDs

### 37. Error shape finally converges on `{error:{code,message,correlationId}}`

REQUIREMENTS.md's cross-cutting section has specified this shape since Week 1;
every service instead shipped `{statusCode,success,message,data}`, flagged as a
known gap in three earlier sessions rather than fixed, since fixing it wasn't
in scope for whatever endpoint was being built at the time. Correlation ID
forces the issue: it has to be "in every error body," which means touching
every service's `errorHandler.js` regardless — completing the shape fix in the
same edit costs nothing additional and finally closes a gap that kept getting
deferred. `shared/httpError.js` centralizes the status→code mapping so the
`code` string can't drift between services the way the enclosing shape did.
Success responses (`{statusCode,success,message,data}`) are untouched — the
spec's shape requirement names only the error envelope, so only that changed.

### 38. Proxy errors get their own `on.error` handler, not the library's default

`http-proxy-middleware` v4 ships a default `errorResponsePlugin` that writes a
plain-text body directly and is silently skipped whenever `options.on.error`
is supplied (confirmed in its own `get-plugins.js`) — so providing a custom
handler doesn't risk a double-write race against the default one; it fully
replaces it. This is what lets a downstream failure return the same
`{error:{...}}` shape and `correlationId` as every other error in the system,
rather than a plain-text string a client would have to special-case.

### 39. Downstream failures return 503, not the library's default 504

`http-proxy-middleware`'s own `getStatusCode` maps `ECONNREFUSED`/`ETIMEDOUT`/
etc. to 504 (Gateway Timeout). The written requirement is explicit — "Downstream
service down → 503" — so the custom `on.error` handler always answers 503
regardless of the underlying error code, matching the status codes
REQUIREMENTS.md's cross-cutting section actually names (which lists 503
nowhere as 504's synonym; only 503 appears). A 504 is defensible in general,
but it isn't what was asked for here.

### 40. `proxyTimeout` is an idle timeout, which is exactly why disabling it (not raising it) is correct for SSE

`proxyTimeout` measures no-activity time on the connection to the target, not a
hard cap on total connection duration — confirmed by reading `httpxy`'s
implementation (`proxyReq.setTimeout(ms, cb)`, Node's own idle-timeout
semantics). The stream route's own heartbeat (every 15s, from
`stream.controller.js`) would keep resetting a *large* timeout indefinitely
anyway, so a large-but-finite value would already work in practice. It's set
to `0` (disabled outright) instead, because a stream is long-lived by design —
its end condition is "the client disconnected," never "too much time passed" —
and expressing that as "a very large number, chosen to outlast the heartbeat"
is a magic constant standing in for "there is no timeout here," when the code
can just say that directly.

### 41. Correlation ID crosses the pub/sub hop by riding in the message body

Redis pub/sub has no header concept — a `PUBLISH`/`SUBSCRIBE` message is just a
string. The only way the id can survive the HTTP→Redis→SSE hop
("gateway → booking → pub/sub → SSE") is to be part of the JSON payload
`publishAvailabilityChange` already sends, so it's added there
(`{type, ticketIds, correlationId}`) rather than invented as a separate
mechanism. `sse/subscriber.js` reads it back out of the same payload it already
parses and logs it — the only two touchpoints needed to make the whole chain
traceable by one id, since everything in between (Redis itself) just carries
opaque bytes.

### 42. "Every log line of every service" is honored for the request lifecycle and the named trace path — not retrofitted onto every pre-existing log statement

A genuine scope boundary, stated plainly rather than glossed over: dozens of
`console.log`/`console.error` calls already existed across event/booking/search/
the outbox poller before this session (ticket minting, hold claims, transaction
retries, ...), many in background workers with no `req` in scope at all. Every
one of those was NOT retrofitted to carry a correlation id — that would be a
purely mechanical sweep with no design decision left in it, and it wasn't
undertaken here. What *is* built and tested: a `requestLogger` middleware
giving every HTTP request in every service exactly one access-log line carrying
its id; `errorHandler`'s own log line does the same for unexpected errors; and
the specific path the acceptance criterion names — gateway → booking → pub/sub
→ Event Service's subscriber — is fully wired and provable by grepping one id
across three services' stdout. The claim is bounded to what was actually built,
not stretched to cover log lines nobody touched.

---

## Week 4 Day 2 — Auth Service

### 43. bcrypt over argon2, and why the cost factor is the whole point

Both were installed at scaffolding time as candidates (`bcrypt` in
`package.json`); bcrypt is used. Argon2id is the newer, generally-preferred
answer (memory-hard, resists GPU/ASIC parallelization better) — the choice
here is pragmatic, not a claim that bcrypt is superior. What actually matters
for the acceptance criterion is not which algorithm but that it has a **tunable
cost factor** at all: a fast hash (SHA-256, MD5) computes in microseconds no
matter how it's configured, so an offline attacker with a leaked
`password_hash` column can try billions of guesses a second. bcrypt's cost
factor (12 here) is deliberately expensive **by design**, tunable upward as
hardware gets faster — the property "slow KDF" names is this tunability, not
brand loyalty to one algorithm.

### 44. Timing-safe login: same message, same cost, on every failure path

`login()` in `services/auth/services/auth.service.js` runs `bcrypt.compare`
on *every* rejected login, including one where no user was found at all —
against a `DUMMY_HASH` precomputed once at module load with the same cost
factor real hashes use. Two things had to both be true for this to work:
- **The dummy hash is precomputed at boot, not lazily on first miss.** A
  lazily-computed hash would make the *first* wrong-email attempt visibly
  slower than every subsequent one (paying the one-time bcrypt.hash cost
  inline), which is itself a timing tell — just a one-shot one instead of a
  per-request one.
- **The error message is identical text** ("Invalid email or password") for
  both "no such user" and "wrong password." Timing-safety without
  message-safety is half a fix — an attacker doesn't need a stopwatch if the
  response body already says which one happened.

### 45. Refresh tokens are opaque and hashed — not because it's "more secure" in the abstract, but because it's the only thing that makes logout real

A JWT is verified by recomputing its signature — nothing server-side ever
"looks it up," so nothing server-side can flag one as revoked without a
blacklist keyed by... something, which is a stateful side-channel to the
supposedly stateless token anyway. Making the refresh token opaque (a random
value, not a JWT) and storing its hash in Postgres sidesteps the contradiction
entirely: revocation is `UPDATE ... SET revoked_at = now()`, checked on every
use (`getActiveRefreshToken`'s `revoked_at IS NULL`). This is *why* two token
types exist at all, not an arbitrary design flourish — the access token is
fast and stateless for the common case (verified on every request without a
DB round trip); the refresh token is the one point where "can this be revoked"
actually needs to be true, so it's the one built to support it.

Hashed with sha256, not bcrypt, unlike the password — see the schema comment
on `refresh_tokens.token_hash` (#-numbered decision folded into
`db/schema.sql` directly): a refresh token is 256 bits of `crypto.randomBytes`,
never typed or reused, so there is no low-entropy guessable space a slow KDF
would be defending against. A fast hash is correct here; using bcrypt would
just be slow for no security benefit.

### 46. No refresh-token rotation — a deliberate, smaller choice than the "better" one

`/auth/refresh` returns only a new access token; the same refresh token
remains valid until its own expiry or an explicit logout. Rotation (issuing a
new refresh token on every use and revoking the old one) is the stronger
practice — it bounds how long a stolen-but-unused refresh token stays useful
once the legitimate client refreshes again — and was considered and left out
here. Reason: REQUIREMENTS.md's acceptance criterion says only "`/auth/refresh`
issues a new access token," and rotation changes the client contract (the
caller must now persist a new refresh token from every refresh response, or
their session silently breaks the next time they try to reuse the old one).
Adding that silently, beyond what was asked, would be a bigger and riskier
change than the task called for. Worth revisiting if refresh-token theft is a
real threat model for this system — noted here rather than decided past what
was requested.

---

## Week 4 Day 3 — Gateway authn + authz

### 47. Why trusting `X-User-Id`/`X-User-Role` downstream is safe — and the one thing that has to be true for it to stay that way

Booking Service's `requireUserId` (built in Week 1, before any of this
existed) reads `x-user-id` off the request header and trusts it completely —
by construction, nothing in that function can tell a gateway-verified id from
one a client typed into curl by hand. That is only safe under one condition,
and it is a **network topology** fact, not something this code can enforce
itself: **the service must be unreachable except through the gateway.** In
this system that is `docker-compose.yml`'s job — `auth`/`event`/`search`/
`booking` publish no host port at all (verified structurally: only `gateway`
has a `ports:` entry), so from outside the compose network there is no way to
reach Booking Service directly and hand it a forged header. The gateway
strips and overwrites `X-User-Id`/`X-User-Role` on every request
(`routes/proxy.js`'s `on.proxyReq`) specifically so that even a client who
*does* have network access to the gateway cannot make their own header value
survive the hop — but that stripping only matters because the gateway is the
sole entry point in the first place. If a future deployment ever exposed a
service port directly (a debug port left open, a load balancer misconfigured
to route around the gateway), this entire trust model breaks silently — the
downstream service has no way to know it is being bypassed. This is the
textbook confused-deputy shape: the service (deputy) acts on an identity claim
it cannot itself verify, trusting that only an honest broker (the gateway)
ever hands it one.

### 48. `POST /events` with `role=user` is 403, not 401 — because the two questions are genuinely different

401 answers "do I know who you are." 403 answers "given who you are, are you
allowed to do this." A `role=user` caller presenting a perfectly valid,
unexpired, correctly-signed JWT has fully answered the first question — the
gateway *does* know who they are — and is refused only on the second. Folding
both into 401 (a common shortcut) would make "your token is bad" and "your
token is fine but you're not allowed" indistinguishable to the client, which
is a worse API: one says "log in again," the other says "you cannot do this
regardless of how you log in." `enforceAccess.js` encodes this directly —
`policy.auth === 'required' && !req.user` is the 401 branch; `policy.roles`
is checked only afterward, and only fails with 403.

### 49. `GET /search`: public *and* rate-limited *and* "keyed on the injected userId" are in tension — resolved as optional auth

REQUIREMENTS.md's own two rows are, read literally, incompatible for this one
route: the routing table marks `/search` public (no auth required), while
Day 4's rate-limiter criterion says the limiter must key on the **injected**
userId, which by definition doesn't exist for an unauthenticated caller.
Rather than silently pick one requirement over the other, `authenticate.js`
always attempts to verify a Bearer token if one is present — succeeding or
failing, it never itself rejects — and `policy.js` marks `/search` as
`auth: 'optional'`: a present, valid token is used opportunistically
(`enforceAccess.js` keys the limiter on `user:${req.user.id}`), while a
missing or invalid one is simply treated as anonymous and keyed on
`ip:${req.ip}` instead. This keeps the route genuinely public (nobody is
required to authenticate to search) while still honoring per-user keying for
every caller who happens to be logged in — which, for a client-side search
box behind an already-authenticated app session, is the common case in
practice. IP-keying is the honest fallback for the remaining anonymous
sliver of traffic, not the default the requirement warns against (see #51).

---

## Week 4 Day 4 — Sliding-window rate limiter

### 50. Sliding-window log (Redis ZSET), not fixed-window or a sliding-window counter

Three algorithms were on the table, per the concept list:
- **Fixed window** (e.g. a counter that resets every `:00` boundary) is
  rejected explicitly by the acceptance criteria — it lets a client send N
  requests in the last millisecond of one window and N more in the first
  millisecond of the next, 2N requests in a blink, without ever technically
  exceeding "N per window."
- **Sliding-window counter** (a weighted average of the current and previous
  fixed windows) fixes the boundary problem approximately, cheaply, in O(1)
  space — but it's an *approximation*, and reasoning about "is the atomic
  increment+check actually correct" is harder to argue for a formula than for
  an exact structure.
- **Sliding-window log** (every request timestamp is its own ZSET member,
  purged by score before every count) is exact — at any instant, `ZCARD`
  after the purge is the literal count of requests in the trailing
  `windowMs`, no averaging, no boundary. Cost: O(requests-in-window) memory
  per key instead of O(1), which is fine at this system's scale and is the
  right trade for correctness this system's tests can actually verify against.

Chosen for the same reason the booking-confirm guard chose an exact
compare-and-swap over an approximation: at this scale, exactness costs little
extra and is far easier to defend when the acceptance test asks "does the
window actually slide."

### 51. Keyed on the injected userId, not IP — why IP is the wrong default

IP address identifies a network endpoint, not a person. Everyone behind one
NAT — an office, a campus network, a mobile carrier's shared gateway — shares
one IP, so an IP-keyed limit throttles all of them as a single caller; one
heavy user exhausts the budget for everyone else on that connection. Keying
on the gateway-verified `userId` instead means the limit tracks the actual
caller, unaffected by how many other people happen to share their network
path. IP-keying is used here only as the deliberate, narrower fallback for
the one route (`/search`) that permits genuinely anonymous traffic — see
#49 — never as the general-purpose key.

### 52. `POST /webhooks/stripe` is exempt from both — because rate-limiting it would lose money, not just annoy a client

Stripe's own retry behavior is the mechanism this would break: if the gateway
ever 429s a webhook delivery, Stripe treats that as a failed delivery and
retries on its own schedule, but a burst of legitimate events (a flash sale, a
batch of confirmations landing together) is exactly the traffic pattern most
likely to *look* like abuse to a naive per-caller rate limiter — except the
"caller" here is Stripe's infrastructure, not an attacker, and every one of
those events represents money that has already moved. Rejecting one is not
"the client can just retry the search box" — it's "a payment confirmation
did not reach the system that needs to know about it," which can mean a
customer paid and never got their booking, or a refund event never
processed. The webhook's own security is Stripe's signature over the payload,
verified inside Booking Service — a concern entirely orthogonal to whether
the *caller* is who a JWT would say it is, which is what the gateway's
auth layer checks and this endpoint has no JWT to check in the first place.

---

## Week 5 Day 1 — Queue join + position

### 53. Queue position is a Redis-side INCR sequence, not a timestamp score

A timestamp score risks ties: two joins landing in the same millisecond would
score identically, and `ZRANK` doesn't define a stable order between tied
members — whichever the tie resolves to could go either way on a re-read,
which is a monotonicity bug hiding in plain sight. An `INCR`-backed sequence
counter can't tie, at any request rate, because Redis serializes it — this is
what makes "position never increases across polls" provable rather than
merely usually-true. It also makes the join-or-return-existing check
(`ZSCORE` then, only on a miss, `INCR`+`ZADD`) safe to express as one Lua
script: the atomicity is what stops two concurrent joins from the same user
both observing "not yet a member" and both inserting a second entry.

### 54. The queue token is a second, separate credential from the login JWT — on purpose

Booking Service already trusts `X-User-Id` as the caller's real identity
(gateway-injected, per Week 4). The queue token doesn't re-assert identity —
it asserts *slot ownership*: "this specific login, at this specific event,
holds a specific place in line." Two independent signals only in combination
make token theft detectable: the token's own `sub`/`eventId` claims, checked
against the *real*, independently-verified `X-User-Id` for the request. A
design that trusted the token's claims alone (no cross-check against the real
caller) would let a stolen token work perfectly for whoever holds it — it
would still verify, still decode a valid userId, just not the *right* one.
The 401 fires specifically because the two signals disagree, not because
either one alone was invalid.

### 55. Both mismatch cases are 401, not 403 or 404

A token bound to someone else's userId, or to a different event, is neither
"you're not allowed" (403 — that implies the identity is right and the
privilege is missing) nor "no such queue entry" (404 — that implies the
request was honest but the resource isn't there). It's "this credential
doesn't prove what you're claiming it proves" — the same shape of failure a
tampered access token is, elsewhere in this system, which is also 401.
Consistency here matters for a client: every "your credential is wrong"
failure across the whole API answers the same way.

### 56. ETA is a real range from two measured windows, or an honest "no data" — never `position / assumed_rate`

Two window sizes (a longer baseline, a shorter recent one) produce two
different measured rates from the *same* underlying departure data —
`countRecentDepartures` over each window — which is what turns "an ETA" into
an actual range instead of one number with invented confidence. Before Day 2's
admitter exists, nobody ever departs the queue, so both windows read zero and
`estimateEta` returns `etaSecondsMin/Max: null` with a message, not `Infinity`
or a silently-wrong number — a caller checking `if (etaSecondsMax)` gets a
real signal that no estimate is available yet, rather than a value that looks
computed but isn't grounded in anything.

---

## Still open

- **Why holds are in Redis and bookings are in Postgres** — argued in (4) and (7);
  still wants the one-line statement of which failure each store tolerates.
- **On cancel, does the `booking_items` row get deleted or does the unique
  constraint move?** — leaning delete, per the reasoning in (5); confirm when the
  cancel path is built (Week 5).
