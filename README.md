# Ticket Master Server

An event ticketing service. Browse and search events, view a live seat map, hold seats for 10 minutes, pay, get a ticket — without ever selling the same seat twice.

Read-heavy with violently spiky writes: a popular event goes from idle to 100:1 oversubscription in seconds. The system is split into independent services behind an API gateway so the browse path, the search path, and the booking path scale separately, and a virtual waiting room bounds how many users are inside the booking flow at once.

```
                    ┌──────────────┐
   client ─────────▶│ API Gateway  │ authn/authz · rate-limit · routing · correlation-id
                    └──────┬───────┘
        auth   search      │      events        booking
      ┌────────┬───────────┴───────────┬──────────────┐
      ▼        ▼                       ▼              ▼
┌─────────┐┌──────────┐        ┌─────────────┐ ┌─────────────┐
│Auth Svc ││Search Svc│        │ Event Svc   │ │ Booking Svc │
│register ││ fuzzy    │        │ CRUD        │ │ reserve     │
│login    ││ multi-   │        │ seat map    │ │ confirm     │
│refresh  ││ filter   │        │ SSE stream  │ │ cancel      │
└────┬────┘└────┬─────┘        └──┬───────▲──┘ │ queue       │
     │          │                 │       │    │ admission   │
     │          ▼                 │       │    └──┬───────┬──┘
     │  ┌───────────────┐         │       │       │       │
     │  │ Elasticsearch │◀────────┼───────┼───────┘       ▼
     │  └───────▲───────┘         │       │          ┌─────────┐
     │          │ outbox poller   │       │ pub/sub  │ Stripe  │
     │          │                 ▼       │          └─────────┘
     │   ┌──────┴──────┐    ┌───────────┐ │
     └──▶│ PostgreSQL  │    │   Redis   │─┘
         │ source of   │    │ holds     │
         │ truth       │    │ queue     │
         │ · money     │    │ cache     │
         │ · bookings  │    │ pub/sub   │
         └─────────────┘    └───────────┘
                                  ▲
                            ┌─────┴──────┐
                            │  Admitter  │ drains queue into booking flow
                            └────────────┘
```

**Holds live in Redis with a TTL. Money lives in Postgres.** A lost hold reopens a seat, which is harmless. A lost booking is not. Redis is the fast path; Postgres is the arbiter.

## Documentation

| Doc | What's in it |
|-----|--------------|
| [REQUIREMENTS.md](REQUIREMENTS.md) | Cold-build learning spec — domain model, invariants, per-day acceptance criteria |
| [TIMELINE.md](TIMELINE.md) | 6-week dated schedule, time boxes, retest ledger |
| [DECISIONS.md](DECISIONS.md) | Every non-obvious choice and why — 60+ numbered entries. **Grep it, don't read it** |
| [CLAUDE.md](CLAUDE.md) | Orientation for AI agents: conventions, layering, where the shape deviates |

Those four are the whole documentation set. There is no `docs/` directory —
architecture, data model, hold semantics, and the waiting-room design are all
argued in `DECISIONS.md` next to the decision that produced them, which is
where they stay current. A separate `docs/` tree would be a second place to
forget to update.

## Stack

- **Node.js + Express** — four services, two workers
- **PostgreSQL** — source of truth for events, tickets, bookings, payments, users
- **Redis** — seat holds (TTL), waiting-room queue, event cache, rate-limit counters, pub/sub
- **Elasticsearch** — event search index, fed by CDC from Postgres
- **Stripe** (test mode) — payments, refunds, webhooks
- **Docker Compose** — local orchestration

## Ports

| Service | Port | Public? |
|---------|------|---------|
| API Gateway | 3000 | yes — only public entry point |
| Auth Service | 3001 | no — internal |
| Event Service | 3002 | no — internal (CRUD, seat map, SSE) |
| Search Service | 3003 | no — internal |
| Booking Service | 3004 | no — internal |
| Outbox poller | — | worker, no inbound port |
| Admitter | — | worker, no inbound port |
| PostgreSQL | 5432 | no |
| Redis | 6379 | no |
| Elasticsearch | 9200 | no |

## Quickstart

```bash
# 1. bring up datastores
docker compose up -d postgres redis elasticsearch

# 2. apply schema
npm run migrate:up

# 3. seed one small event and one 50,000-ticket event
npm run seed

# 4. run all services + workers
npm run dev

# 5. register + login
curl -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"prachi@bytive.in","password":"correct-horse-1"}'

curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"prachi@bytive.in","password":"correct-horse-1"}'
# → 200 { "accessToken":"...", "refreshToken":"...", "expiresIn":900 }

# 6. search events (fuzzy, multi-filter)
curl 'http://localhost:3000/search?term=conc&location=Pune&date=2026-10-01'

# 7. live seat map
curl http://localhost:3000/events/1/seatmap
# → 200 { "tickets":[{"id":7,"seat":"A12","price":5000,"status":"available"}, ...] }

# 8. watch it change in real time
curl -N http://localhost:3000/events/1/stream
# → event: seat.held  data: {"ticketId":7,"expiresAt":"..."}

# 9. join the waiting room, get admitted
curl -X POST http://localhost:3000/queue/join \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{"eventId":1}'
# → 202 { "queueToken":"...", "position":4128, "etaSeconds":[180,420] }

curl 'http://localhost:3000/queue/position' \
  -H 'Authorization: Bearer <accessToken>'
# → 200 { "position":0, "admitted":true, "admissionExpiresAt":"..." }

# 10. hold seats for 10 minutes
curl -X POST http://localhost:3000/bookings/reserve \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{"eventId":1,"ticketIds":[7,8]}'
# → 201 { "holdId":"...", "ticketIds":[7,8], "expiresAt":"2026-08-18T10:12:00Z" }

# 11. pay — note: no amount in the body, the server derives it
curl -X POST http://localhost:3000/bookings/confirm \
  -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{"eventId":1,"ticketIds":[7,8],"paymentMethodId":"pm_card_visa"}'
# → 201 { "bookingId":91, "status":"confirmed", "totalAmount":10000 }

# 12. cancel — releases seats, refunds, notifies the waitlist
curl -X POST http://localhost:3000/bookings/91/cancel \
  -H 'Authorization: Bearer <accessToken>'
# → 200 { "bookingId":91, "status":"refunded" }
```

## Repository layout

```
ticket-master-server/
├── README.md
├── REQUIREMENTS.md          # cold-build learning spec
├── TIMELINE.md              # 6-week dated schedule
├── DECISIONS.md             # every non-obvious choice + why. Grep it, don't read it
├── CLAUDE.md                # orientation for AI agents working in this repo
├── docker-compose.yml       # datastores by default; --profile full adds services
├── .dockerignore
├── package.json             # root tooling only (seed/reset/hammer). NOT a workspace root
├── db/
│   └── schema.sql           # entire schema, one file, no migration tool
├── scripts/                 # run via npm from the repo root
│   ├── seed.js                      # npm run seed  — small event + 50,000-ticket event
│   ├── reset.sh                     # npm run reset — wipe Postgres + Redis
│   ├── concurrency-harness.js       # npm run hammer
│   └── booking-concurrency-test.js  # booking-confirm acceptance script
├── shared/                  # cross-service contracts, imported by relative path
│   ├── availability.js      # hold keys, expiry, readLiveHolds, pub/sub channels
│   ├── queue.js             # waiting-room key naming
│   ├── searchIndex.js       # ES index/mapping + toSearchDocument
│   ├── correlationId.js     # header name + generate-or-reuse
│   ├── httpError.js         # status → error-code mapping
│   └── roles.js             # role list + role groups
└── services/
    ├── gateway/       :3000  # only process with a published port
    ├── auth/          :3001
    ├── event/         :3002  # CRUD, cache, seat map, SSE
    ├── search/        :3003
    ├── booking/       :3004  # reserve, confirm, holds, queue
    ├── admitter/             # worker, no inbound port — drains queue, leader lease
    └── outbox-poller/        # worker, no inbound port — Postgres → Elasticsearch
```

Workers live under `services/` alongside the HTTP services rather than in a
separate `workers/` tree — same internal conventions (`config/`,
`repositories/`, `services/`), just no `app.js` or `routes/`.

Each service has the same internal shape:

```
services/booking/
├── Dockerfile               # build context is the REPO ROOT, not this dir
├── package.json             # own deps, own node_modules
├── server.js                # dotenv, connect stores, listen, graceful shutdown
├── app.js                   # express app, /health, middleware chain, router
├── config/                  # db.js, redis.js — clients and pool sizes
├── routes/                  # thin, path → controller
├── controllers/             # identity + validation + status codes
├── services/                # order of operations, maps results to errors
├── repositories/            # SQL and Lua. Never throws HTTP errors
├── validators/              # runs before any datastore call
├── middlewares/             # correlationId, requestLogger, errorHandler
└── utils/                   # apiError, response, transaction, money, holdId
```

Four things worth knowing about this layout:

**Every service is independently buildable and deployable.** One image per service, own port, own container, own `node_modules`. Dockerfiles take the **repo root** as build context, because `event` and `booking` copy `shared/`, which sits outside their own folder:

```bash
docker build -f services/booking/Dockerfile -t tm-booking .
```

`auth`, `search`, and `gateway` don't reference `shared/`, so their Dockerfiles don't copy it.

**`shared/` is plain relative imports, not an npm workspace.** `shared/package.json` has no `name`, and no service depends on it — every import is `../../../shared/<file>.js`. It exists so a writer and a reader agree on exact key names: Booking writes hold keys, Event Service reads them, and two copies of those names would drift silently.

The cost is a **lockstep deploy**: changing a key name in `shared/` requires deploying every reader and writer together, or the seat map shows held seats as free. Treat it like an `ALTER TABLE` — dual-write both names, deploy both, then drop the old. Keep `shared/` to constants, key builders, and one shared read; the moment business logic lands there, every service redeploys on every change.

**Only the gateway publishes a port.** In compose, nothing else has a `ports:` mapping, so the rest are reachable only on the `internal` network. "Service ports are not public" is a property of the deployment, not a promise in a doc — but it's a network assumption the code itself cannot enforce, since every service trusts the `X-User-Id` / `X-User-Role` headers the gateway injects.

**Repositories never throw HTTP errors.** `hold.repository.js` returns a status string; `hold.service.js` maps it to `createApiError`. Keeps Redis and SQL out of the controller and status codes out of the data layer.

## Scope honesty

Single-node Postgres, Redis, and Elasticsearch. No replication, no failover. Multi-instance tests run several local processes, not machines or network partitions.

All services share one database — Event Service and Booking Service both read `tickets`. That's a split-by-process, not real service isolation: the data coupling remains, network hops were added. Real boundaries mean a database per service, which turns the booking↔ticket write into a distributed transaction. Deliberate trade, and the honest answer to "who owns the tickets table?" is "shared, and that's the compromise."

CDC is a transactional-outbox poller, not log-based replication. Debezium + Kafka is the production answer — describable here, not demonstrable.

Per-user ticket caps and payment-instrument uniqueness are in scope. Nothing here stops an attacker holding 10,000 verified identities; that's identity verification, and it's the part real Ticketmaster still loses.
