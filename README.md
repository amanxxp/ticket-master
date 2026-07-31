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
| [DECISIONS.md](DECISIONS.md) | Locked choices and the one-line reason for each |
| [BLOCKERS.md](BLOCKERS.md) | Weekly blockers log + wrong predictions from the failure-injection drill |
| [docs/architecture.md](docs/architecture.md) | Component responsibilities, request flows, why the split is where it is |
| [docs/api.md](docs/api.md) | Full HTTP API reference |
| [docs/data-model.md](docs/data-model.md) | PostgreSQL schema, indexes, DDL, the three double-book guards |
| [docs/holds-and-seatmap.md](docs/holds-and-seatmap.md) | Redis hold structures, O(1) seat-map read, SSE fan-out |
| [docs/waiting-room.md](docs/waiting-room.md) | Admission control, leader election, fairness policy, waitlist |
| [docs/payments.md](docs/payments.md) | Idempotency, webhooks, refunds, reconciliation |
| [docs/search.md](docs/search.md) | Elasticsearch mapping, query DSL, transactional outbox CDC |
| [docs/scaling.md](docs/scaling.md) | Capacity estimates, bottlenecks, failure modes |
| [docs/deployment.md](docs/deployment.md) | Running locally, env vars, ports, Docker Compose, ops runbook |

REQUIREMENTS and TIMELINE exist now. Everything else gets written as you build the thing it describes — a doc for a component you haven't built yet is fiction.

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
├── DECISIONS.md             # locked choices + one-line reasons
├── BLOCKERS.md              # weekly log + wrong predictions
├── docker-compose.yml       # datastores by default; --profile full adds services
├── .dockerignore
├── package.json             # npm workspace root
├── db/
│   └── schema.sql           # migrations replace this (Week 0 item, still open)
├── docs/                    # written as each component is built
├── scripts/
│   ├── seed.js              # 50-ticket event + 50,000-ticket event
│   ├── reset.sh             # truncate bookings, free tickets, flush redis
│   └── concurrency-harness.js   # N parallel requests, tallies status codes
├── shared/                  # workspace package @tm/shared
│   ├── package.json
│   └── availability.js      # hold key names, expiry semantics, Lua helpers
├── services/
│   ├── gateway/             # 3000 — authn/authz, rate-limit, routing
│   ├── auth/                # 3001 — register, login, refresh, logout
│   ├── event/               # 3002 — CRUD, cache, seat map, SSE
│   ├── search/              # 3003 — Elasticsearch queries
│   └── booking/             # 3004 — reserve, confirm, cancel, queue, Stripe
└── workers/                 # Week 3 / Week 5
    ├── outbox-poller/       # Postgres → Elasticsearch
    └── admitter/            # drains queue, single-leader
```

Each service has the same internal shape:

```
services/booking/
├── Dockerfile               # build context is the REPO ROOT, not this dir
├── package.json             # own deps; @tm/shared where needed
├── server.js                # connect stores, listen, graceful shutdown
├── app.js                   # express app, /health, router, error handler
├── config/                  # db.js, redis.js — clients and pool sizes
├── routes/                  # thin, path → controller
├── controllers/             # identity + validation + status codes
├── services/                # order of operations, maps results to errors
├── repositories/            # SQL and Lua. Never throws HTTP errors
├── validators/              # runs before any datastore call
├── middlewares/             # errorHandler
└── utils/                   # apiError, response, transaction, money, holdId
```

Four things worth knowing about this layout:

**Every service is independently buildable and deployable.** One image per service, own port, own container. Dockerfiles take the **repo root** as build context, because services import `@tm/shared` from outside their own folder:

```bash
docker build -f services/booking/Dockerfile -t tm-booking .
```

**`@tm/shared` is an npm workspace package, not a relative import.** `shared/availability.js` holds hold-key names and expiry semantics; Event Service reads those keys, Booking Service writes them, and two copies of the names would drift — drift here renders a held seat as available.

The cost is a **lockstep deploy**: changing a key name in `shared/` requires deploying Event and Booking together, or the seat map shows held seats as free. Treat a change there like an `ALTER TABLE` — dual-write both names, deploy both, then drop the old. Keep `shared/` to constants and key builders; the moment business logic lands there, every service redeploys on every change.

**Only the gateway publishes a port.** In compose, the other four are reachable only on the `internal` network. "Service ports are not public" is then a property of the deployment, not a promise in a doc.

**Repositories never throw HTTP errors.** `hold.repository.js` returns a status string; `hold.service.js` maps it to `createApiError`. Keeps Redis and SQL out of the controller and status codes out of the data layer.

## Scope honesty

Single-node Postgres, Redis, and Elasticsearch. No replication, no failover. Multi-instance tests run several local processes, not machines or network partitions.

All services share one database — Event Service and Booking Service both read `tickets`. That's a split-by-process, not real service isolation: the data coupling remains, network hops were added. Real boundaries mean a database per service, which turns the booking↔ticket write into a distributed transaction. Deliberate trade, and the honest answer to "who owns the tickets table?" is "shared, and that's the compromise."

CDC is a transactional-outbox poller, not log-based replication. Debezium + Kafka is the production answer — describable here, not demonstrable.

Per-user ticket caps and payment-instrument uniqueness are in scope. Nothing here stops an attacker holding 10,000 verified identities; that's identity verification, and it's the part real Ticketmaster still loses.
