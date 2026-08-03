# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An event-ticketing backend split into five HTTP services + two workers behind
an API gateway, built incrementally as a cold-build learning exercise
(`REQUIREMENTS.md` is the spec, `TIMELINE.md` is the schedule, `DECISIONS.md`
is the running log of every non-obvious choice and why). Read `DECISIONS.md`
before re-deciding something that's already there — it exists specifically so
choices aren't re-litigated.

**`DECISIONS.md`'s highest entry number is the reliable progress signal.**
`TIMELINE.md`'s "You are here" marker is hand-maintained and goes stale between
updates; when it and the code disagree, the code wins.

### Where answers live — check here before reading code

`DECISIONS.md` is ~1000 lines and past 60 numbered entries. **Grep it, don't
read it.** It is the answer to "why is this weird?" and the reason not to
re-litigate:

| Question | Look here |
|---|---|
| Why was this built this way? | `grep -n -i "<keyword>" DECISIONS.md`, then read that entry |
| What is the product supposed to do? | `REQUIREMENTS.md` — the spec, stable |
| What's the shape of the code? | this file, "Repo layout" below |
| What state is the working tree in? | run `git status` / `git log --oneline -10`. **Do not trust any file in the repo for this** |
| What's built vs not? | `git log` + `DECISIONS.md`'s highest entry number |
| Where in the schedule? | `TIMELINE.md`'s "You are here" — hand-maintained, verify against `git log` |

**No automated test suite exists** (see Commands). That is a known state, not
something to fix on sight.

`README.md` is written for a human arriving at the repo; this file is written
for an agent working in it. Where they overlap, this file is the one kept
current — if `README.md` contradicts the code, fix `README.md` rather than
working around it.

## How to help here — this repo is a cold-build exercise

`TIMELINE.md` is explicit: *"cold build, no AI code, 35-min timer per
component, blank file, no reference open."* The point of the repo is that the
author can defend every line from memory. **Writing production code for them
destroys the deliverable**, even when they ask for it — a working endpoint
they didn't build is worse than no endpoint.

Default to, in order of preference:

1. **Review** what they wrote — bugs, missed acceptance criteria, layering violations.
2. **Answer the "why"** — grep `DECISIONS.md`, explain the trade-off, name the failure mode.
3. **Point at the acceptance criteria** in `REQUIREMENTS.md` for the day they're on.
4. **Plumbing they've explicitly delegated** — `server.js`, Compose, scripts, env wiring. `TIMELINE.md` calls this out as "plumbing, not the exercise."

Write domain code (validators, repositories, services, controllers) only on an
explicit, specific request — and say plainly that it's the author's cold-build
work being done for them, so they can decide to rebuild it. Some of the
existing `event` venue/CRUD code was written by an assistant this way; it has
not been rebuilt cold.

When they say "test at the end" or skip verification, note what is therefore
**unverified** rather than reporting it as working.

## Commands

There is no root build/test/lint command — each service is independently run
and has no wired test script (`"test": "echo ... && exit 1"` in every
`package.json`). **No automated test suite is committed to this repo at all.**
Verification during development has been done with throwaway `node:test`
files run directly (`node --experimental-test-module-mocks --test <file>`)
against mocked Postgres/Redis/ES — none of that is checked in. If you add
real tests, decide where they should live; there's no existing convention to
follow.

```bash
# Datastores (Postgres, Redis, Elasticsearch) — no `docker compose` (space)
# plugin here, use the hyphenated legacy binary the scripts assume:
docker-compose up -d postgres redis elasticsearch

# Schema — no migration tool. One file, applied directly:
psql -h localhost -U ticketmaster -d ticketmaster -f db/schema.sql

# Seed a small event + a 50,000-ticket event, for load-shaped testing:
npm run seed        # from repo root — node scripts/seed.js

# Reset Postgres + Redis to a clean slate between test runs
# (booking/ticket state carries over otherwise and fails cap assertions):
npm run reset        # scripts/reset.sh

# Hammer an endpoint with N parallel requests, tally status codes:
npm run hammer -- --url http://localhost:3004/bookings/confirm --method POST \
  --body '{"eventId":"1","ticketIds":["1"]}' -n 50

# Booking-confirm concurrency acceptance script (50-concurrent, overlapping
# sets, opposite lock order, guard-removal — see the script's own comments):
node scripts/booking-concurrency-test.js
```

Each service is run individually — there is no root `dev`/`start` that boots
everything at once:

```bash
cd services/<name> && npm run dev     # node --watch server.js (auth/event/gateway/search/booking)
cd services/admitter && npm start     # node admitter.js — worker, no --watch script
cd services/outbox-poller && npm start
```

Full stack via Compose (`--profile full` is required — the default `up`
deliberately excludes service containers so a stale image never shadows what
you're editing on the host):

```bash
docker-compose --profile full up -d --build
```

To exercise "two admitter instances, no over-admission" for real:
```bash
docker-compose --profile full up -d --build --scale admitter=2
```

## Repo layout

```
ticket-master-server/
├── db/schema.sql            # entire schema, one file, no migration tool
├── docker-compose.yml       # datastores by default; services behind --profile full
├── scripts/                 # root-level tooling, run via npm from repo root
│   ├── seed.js                  # npm run seed   — small event + 50,000-ticket event
│   ├── reset.sh                 # npm run reset  — wipe Postgres + Redis
│   ├── concurrency-harness.js   # npm run hammer — N parallel requests, tally statuses
│   └── booking-concurrency-test.js  # booking-confirm acceptance script (run directly)
├── shared/                  # cross-service contracts, plain relative imports
└── services/
    ├── gateway/       :3000  # only process with a published port
    ├── auth/          :3001
    ├── event/         :3002
    ├── search/        :3003
    ├── booking/       :3004
    ├── admitter/             # worker, no inbound port
    └── outbox-poller/        # worker, no inbound port
```

`shared/` file-by-file responsibilities are in the section below — read that
before touching any of them.

### Anatomy of an HTTP service

Each of the five HTTP services is a self-contained npm package (own
`package.json`, own `node_modules`, own `Dockerfile`, own `.env`). No root
`node_modules` for services, no workspaces.

```
services/<name>/
├── server.js        # entry: dotenv, connect datastores, app.listen(PORT)
├── app.js           # express app: middleware chain + mount routes/index.js
├── config/          # datastore clients (db.js / redis.js / elasticsearch.js)
├── routes/          # index.js mounts the rest; each file is path → controller only
├── controllers/     # req/res boundary: identity, validation, status code
├── services/        # business logic; maps failures to createApiError
├── repositories/    # SQL / Lua only — never throws an HTTP status
├── validators/      # runs before any datastore call
├── middlewares/     # correlationId, requestLogger, errorHandler (+ service-specific)
└── utils/           # apiError.js, response.js (+ service-specific helpers)
```

`server.js` / `app.js` are split: `app.js` exports the configured app without
binding a port, `server.js` owns `dotenv`, datastore connect, and `listen`.
Import `app.js` if you need the app without a live listener.

**Where the shape deviates — these are intentional, not gaps to fill in:**

| Service | Deviation |
|---|---|
| `gateway` | No `controllers/`, `services/`, or `validators/`. It proxies; it doesn't own domain logic. Its only repository is `rateLimit.repository.js`. |
| `search` | No `repositories/`. `services/search.service.js` queries Elasticsearch through `config/elasticsearch.js` directly. |
| `event` | Extra `sse/` dir (`registry.js` = live connections, `subscriber.js` = Redis pub/sub consumer). |
| `booking` | Extra `middlewares/requireAdmission.js` — verifies the admission JWT before the route body runs. |
| `admitter`, `outbox-poller` | Workers: entry is `admitter.js` / `poller.js`, no `app.js`, no `routes/`, no `controllers/`. They keep `config/`, `repositories/`, `services/`. |

**Two validation styles coexist** — know which one you're in before adding a
route. `auth` and `event` wire `middlewares/validate.js` at the route level;
`booking` and `search` call their validator directly from inside the
controller. Neither is being migrated to the other; match the service you're
editing.

`utils/apiError.js`, `utils/response.js`, `middlewares/correlationId.js`,
`errorHandler.js`, and `requestLogger.js` are **copied per service, not
imported from `shared/`**. Fixing a bug in one does not fix it in the other
six — grep across `services/` before assuming a fix landed everywhere.

### Conventions

**ESM everywhere.** All eight `package.json` files (seven services + `shared/`)
set `"type": "module"`. Use `import`/`export`; there is no `require`, no
transpile step, no TypeScript. `.js` extensions in import paths are mandatory.

**Config comes from per-service `.env`.** Every service has its own `.env` and
a committed `.env.example` listing the names it reads. `.env` is gitignored
repo-wide. `server.js` (or the worker entry) calls `dotenv/config` first;
nothing reads `process.env` before that. To find what a service accepts, read
its `.env.example` — that is the authoritative list, not this file.

**Response envelopes.** Success goes through `utils/response.js`'s
`responseHandler(data, res, message, status)` →
`{statusCode, success: true, message, data}`. Errors go through
`utils/apiError.js`'s `createApiError` and the `errorHandler` middleware →
`{error: {code, message, correlationId}}`. **The two are structurally
different** — success has no `correlationId`, errors have no `success` flag. A
client cannot branch on one common field; it branches on HTTP status.

**Postgres error codes are mapped in the service layer, not the repository.**
`event/utils/helper.js` exports `rethrowPgError(error, action, entity)` —
`23505`→409, `23503`→400, `23514`→400, anything else logs and rethrows as-is
(becoming a 500). Repositories let pg errors escape untouched; the service
`catch` calls `rethrowPgError`. **Gotcha:** a service that throws its own
`createApiError` (e.g. a 404) inside the same `try` must re-throw it first —
`if (error.isApiError) throw error;` — or `rethrowPgError` swallows the
intended status. See `editVenue` in `event/services/venue.service.js`.

**`validate(schema, source)` — Express 5 makes `req.query` getter-only**, so
the middleware cannot write validated values back in place. `source: "body"`
mutates `req.body`; `"params"` writes `req.validatedParams`; `"query"` writes
`req.validatedQuery`. Controllers must read the `validated*` property —
reading `req.query` gets the raw, uncoerced, un-defaulted value, which is a
silent bug (missing `default`s, string instead of number, unknown keys not
stripped). Default `source` is `"body"`.

**bigserial ids stay strings end to end.** Validators match `/^\d+$/` rather
than `Joi.number()`, and nothing calls `Number()` on an id — past
`Number.MAX_SAFE_INTEGER` that would corrupt the value. `pg` accepts strings
for `bigint` params and returns `bigint` as a string, so the round trip is
already consistent; don't "fix" it into a number.

**camelCase conversion happens in SQL, not JavaScript.** Repositories select
through a column list that aliases (`seat_map AS "seatMap"`, `created_at AS
"createdAt"`), so rows come out of `pg` already in API shape and no mapping
layer exists. Add the alias to that shared column constant when you add a
snake_case column; a bare `SELECT *` leaks `seat_map` into the response.

**Keyset pagination emits `nextCursor: null` on a short page** (`rows.length
=== pageSize` is the test) — a cursor at the end would send the client back
for a page that is always empty.

**Soft delete voids FK protection.** `is_deleted = true` leaves the row in
place, so Postgres happily lets an event keep pointing at a "deleted" venue.
Referential guards must therefore be explicit pre-checks in the service layer
(`countActiveEventsForVenue` → 409), not delegated to the constraint.

**Env vars that must agree across process boundaries.** Nothing validates
these at startup — a mismatch is a runtime 401 or a silently wrong window, not
a crash:

| Variable | Must match between | Breaks as |
|---|---|---|
| `JWT_SECRET` | `auth` (signs) → `gateway` (verifies) | every authenticated request 401s |
| `ADMISSION_TTL_SECONDS` | `booking` (token expiry) ↔ `admitter` (admission window) | admitted users' tokens expire before or after their actual slot |
| `QUEUE_DRAIN_WINDOW_MS` | `booking` ↔ `admitter` | drain-rate/ETA measured over a different window than it's applied to |
| `DB_*`, `REDIS_HOST`/`REDIS_PORT` | every service touching that store | connect failure at boot |
| `ELASTICSEARCH_URL` | `outbox-poller` (writes) ↔ `search` (reads) | poller indexes into a cluster search never queries |
| `AUTH_URL`, `EVENT_URL`, `SEARCH_URL`, `BOOKING_URL` | `gateway` only — must match each service's own `PORT` | 502 on that prefix |

`QUEUE_TOKEN_SECRET` and `ADMISSION_TOKEN_SECRET` are `booking`-only — it both
signs and verifies them, so they need no cross-service agreement. They are
deliberately separate from `JWT_SECRET` and from each other (`DECISIONS.md`
#54, #57).

This is the same failure class as `shared/` key drift below: agreement by
discipline, nothing enforcing it.

## Architecture

### Service boundaries

Gateway (3000) is the only publicly-reachable process — verified structurally
in `docker-compose.yml` (only its block has a `ports:` mapping). Every other
service (auth 3001, event 3002, search 3003, booking 3004) trusts that nothing
reaches it except through the gateway. This is a **network topology
assumption the code cannot enforce itself** — see `DECISIONS.md` #47 for what
has to stay true for it to hold. `outbox-poller` and `admitter` are workers
with no inbound port at all.

Every HTTP service has the same internal shape — `routes/` (thin, path →
controller) → `controllers/` (identity + validation + status code) →
`services/` (business logic, maps failures to `createApiError`) →
`repositories/` (SQL/Lua only; **never throws an HTTP status**, returns data
or a plain status string that the service layer interprets) → `validators/`
(runs before any datastore call, per this repo's rule that `try/catch` around
a query is not validation).

### `shared/` — plain relative imports, not an npm workspace

`shared/` is **not** a workspace package — there's no `name` field in
`shared/package.json` (it exists only to set `"type": "module"`), and no
service's own `package.json` depends on it. Every service imports it with a
relative path three levels up (`../../../shared/xxx.js`). A workspace setup was
tried and reverted; don't reintroduce it without asking. Each file in `shared/` is a
contract between a specific writer and reader that must agree on exact key
names / mappings without guessing at each other's convention:

- `availability.js` — Redis hold-key naming + expiry semantics (Booking writes
  holds, Event Service reads them for the seat map and SSE snapshot) +
  `readLiveHolds`, the one shared read implementation both call
- `queue.js` — waiting-room Redis key naming (Booking owns the waiting queue,
  the Admitter worker owns admission/sold-out state)
- `searchIndex.js` — Elasticsearch index/mapping + `toSearchDocument` (the
  outbox poller writes, Search Service reads)
- `correlationId.js` — one header name + generate-or-reuse function, used by
  every service's `correlationId` middleware
- `httpError.js` — status→error-code mapping for the shared
  `{error:{code,message,correlationId}}` response envelope
- `roles.js` — the role list + role groups (`MANAGER_ROLES`, `ADMIN_ROLES`),
  shared between the DB's own CHECK constraint and the gateway's authz policy

Changing a key name or mapping in `shared/` without updating every
reader/writer is a silent runtime bug (a held seat renders as available, a
search document never gets found), not a type error — nothing enforces
agreement except discipline.

### The gateway is a single policy table, not per-route logic

`services/gateway/middlewares/policy.js` is the one place that decides which
routes are public, which need a role, and which are rate-limited. Everything
else (`authenticate.js`, `enforceAccess.js`, `rateLimit.js`) reads that table;
none of it hardcodes a route's rules inline. When adding a new proxied route,
add a row there — `routes/index.js`'s `prefixFilter`-based proxies only decide
*where* a request goes, not *whether* it's allowed to.

Identity/role headers (`X-User-Id`, `X-User-Role`) are injected in
`routes/proxy.js`'s `on.proxyReq` hook, which unconditionally overwrites (or
strips, if anonymous) whatever the client sent — every downstream service
trusts these headers completely, which is only safe under the network
assumption above.

### Recurring pattern: layered guards, not one guard

The booking-confirm concurrency guard (`services/booking`) stacks three
independent mechanisms — row lock with deterministic ordering (deadlock
avoidance), a conditional `UPDATE ... WHERE status='available'` + rowcount
(the actual guard), and `UNIQUE(ticket_id)` on `booking_items` (a backstop
that still holds if the guard above were disabled — there's a runtime flag,
`BOOKING_DISABLE_ROWCOUNT_GUARD`, specifically to prove this in isolation).
The same "defense in depth, not defense in one place" shape recurs
deliberately elsewhere: the admitter's leader lease is fenced by instance id
(not a bare `SET NX`) *and* the shutdown release is separately fenced; the
admission gate is a self-verifying signed token specifically so the reject
path needs zero store access. When extending any of these, keep every layer —
removing one to "simplify" removes the property the acceptance criteria test.

### The outbox pattern appears twice, same shape both times

Both times a Postgres write needs to eventually reach a second system, the
shape is identical: write a row to the `outbox` table in the *same
transaction* as the real write, and a separate poller drains unpublished rows
into the second system, marking them published as it goes.

- **Event Service → Elasticsearch**: `outbox-poller` claims batches via
  `FOR UPDATE SKIP LOCKED` (so two poller instances never claim the same row),
  applies each row individually inside one transaction (one bad row doesn't
  roll back its neighbors), and only marks a row published after Elasticsearch
  actually accepted it.
- **Booking → Redis pub/sub → SSE**: `publishAvailabilityChange` fires after
  a transaction commits (never inside it — a later rollback must not have
  already announced a change that didn't happen), and always fails open
  (never throws back into the request that triggered it).

### Queue → admission → booking is three separable states, not one flag

A user is `waiting` (in Booking's Redis ZSET, position derived from an
`INCR`-sequence score — never a timestamp, which could tie), `admitted` (the
Admitter worker moved them to a separate ZSET and `GET /queue/position` can
now issue them a signed, self-verifying admission JWT), or `sold_out` (the
Admitter drained the whole queue once inventory hit zero). The admission
**token**, not a Redis lookup, is what `POST /bookings/reserve|confirm` check
before doing any other work — this is deliberate: it's what makes "reject
with zero Redis/DB calls" achievable, since verifying a JWT signature touches
neither store.

### Correlation IDs cross a pub/sub hop by riding in the message body

Redis pub/sub has no header concept, so tracing one request end-to-end
(gateway → booking → pub/sub → Event Service's SSE subscriber) means the
correlation id has to be part of the JSON payload `publishAvailabilityChange`
sends, read back out by `sse/subscriber.js` on the other end. Every service
also gets one `requestLogger` access-log line and the id in every error body —
but pre-existing `console.log` calls scattered through business logic were
**not** retrofitted to carry it; that claim is deliberately bounded to what's
actually wired (see `DECISIONS.md` #42).

### Shared database, deliberately

Event Service and Booking Service both read/write the `tickets` table
directly — a split-by-process, not real service isolation (the data coupling
remains, only network hops were added). This is a named, accepted trade-off
in `README.md`'s "Scope honesty" section, not an oversight.
