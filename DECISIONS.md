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

## Still open

Not yet decided — deliberately, since the code that forces the choice is not
written:

- **Why holds are in Redis and bookings are in Postgres** — partially argued in
  (4) above; needs the explicit statement of which failure each store tolerates.
- **On cancel, does the `booking_items` row get deleted or does the unique
  constraint move?** — leaning delete, per the reasoning in (5); confirm when the
  cancel path is built (Week 2).
- **Clock authority for hold expiry** — Week 2. Two app instances with skewed
  clocks must not disagree about whether a hold expired. Redis' own clock via TTL
  is the likely answer; state it once holds exist.
