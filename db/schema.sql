-- Ticket Master Server — PostgreSQL schema
-- Per REQUIREMENTS.md Domain Model (Week 1 Day 1).
-- IDs: bigserial (simple, no extension dependency). Enums as CHECK constraints
-- (cheaper to extend than ALTER TYPE ... ADD VALUE while the domain is still moving).

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('user', 'organizer', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refresh tokens are opaque and revocable — the reason a stateless access JWT
-- alone can't support logout. `token_hash` only: the raw token is bearer-secret
-- equivalent to a password, but high-entropy and random rather than
-- human-chosen, so a fast hash (sha256) is the right tool here, not a slow KDF —
-- there is no low-entropy space for an attacker to dictionary-search.
CREATE TABLE refresh_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refresh and logout both look up "the active token for this hash" — serves
-- that exact lookup instead of a full table scan.
CREATE INDEX idx_refresh_tokens_active ON refresh_tokens (token_hash) WHERE revoked_at IS NULL;

CREATE TABLE venues (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  location   TEXT NOT NULL,
  seat_map   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted BOOLEAN NOT NULL DEFAULT false
);

-- Keyset pagination scans id ASC over non-deleted rows only.
CREATE INDEX idx_venues_active ON venues (id) WHERE is_deleted = false;

CREATE TABLE performers (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id                    BIGSERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  venue_id              BIGINT NOT NULL REFERENCES venues(id),
  performer_id          BIGINT NOT NULL REFERENCES performers(id),
  event_date            TIMESTAMPTZ NOT NULL,
  max_tickets_per_user  INT NOT NULL,
  -- Fairness policy (Week 5 Day 3). 'fifo' scores the waiting queue by arrival
  -- sequence; 'lottery' opens a registration window first and then scores every
  -- registrant by hash(draw_seed, user_id), which decorrelates position from
  -- arrival time. FIFO is kept as a flag rather than deleted so the two can be
  -- compared on the same code path.
  queue_mode            TEXT NOT NULL DEFAULT 'fifo' CHECK (queue_mode IN ('fifo', 'lottery')),
  -- NULL = no registration window; the queue is open immediately. Non-NULL and
  -- in the future = registration phase, positions do not exist yet.
  sale_opens_at         TIMESTAMPTZ,
  -- Written exactly once, at or after sale_opens_at, by whichever request gets
  -- there first (a conditional UPDATE ... WHERE draw_seed IS NULL). It lives in
  -- Postgres, not Redis, precisely so a Redis flush cannot reshuffle a draw that
  -- has already been shown to users — re-seeding would move positions upward,
  -- which is the one thing the queue promises never happens.
  draw_seed             TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted            BOOLEAN NOT NULL DEFAULT false
);

-- List query filters live/upcoming events and sorts by date. `id` is in the index
-- as the keyset tiebreak: events sharing an event_date need a stable second sort
-- key, or pagination can skip or repeat rows across page boundaries.
CREATE INDEX idx_events_date_active ON events (event_date, id) WHERE is_deleted = false;

-- Serves the ?venueId / ?performerId list filters.
CREATE INDEX idx_events_venue_active ON events (venue_id) WHERE is_deleted = false;
CREATE INDEX idx_events_performer_active ON events (performer_id) WHERE is_deleted = false;

CREATE TABLE tickets (
  id         BIGSERIAL PRIMARY KEY,
  event_id   BIGINT NOT NULL REFERENCES events(id),
  seat       TEXT NOT NULL,
  price      NUMERIC(10, 2) NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('available', 'booked')) DEFAULT 'available',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, seat)
);

-- Seat-map / confirm-path lookup: "tickets for this event in this status".
CREATE INDEX idx_tickets_event_status ON tickets (event_id, status);

CREATE TABLE bookings (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  event_id     BIGINT NOT NULL REFERENCES events(id),
  status       TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'refunded')),
  total_amount NUMERIC(10, 2) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookings_user ON bookings (user_id);

CREATE TABLE booking_items (
  id         BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL REFERENCES bookings(id),
  ticket_id  BIGINT NOT NULL REFERENCES tickets(id) UNIQUE
);

-- Waitlist (Week 5 Day 4). In Postgres, not Redis, because a waitlist entry is
-- long-lived — hours or days between joining and a seat freeing up — and losing
-- it to a Redis restart would silently drop a promise made to a user. Holds can
-- be lost safely (the seat reopens); a waitlist cannot (nobody learns the seat
-- reopened).
--
-- The claim window lives here too, as a timestamp rather than a TTL, so the same
-- row records "notified" and "until when" and a sweeper can find expired claims
-- without a second store to reconcile against.
CREATE TABLE waitlist (
  id                BIGSERIAL PRIMARY KEY,
  event_id          BIGINT NOT NULL REFERENCES events(id),
  user_id           BIGINT NOT NULL REFERENCES users(id),
  status            TEXT NOT NULL DEFAULT 'waiting'
                      CHECK (status IN ('waiting', 'notified', 'claimed', 'expired', 'cancelled')),
  notified_at       TIMESTAMPTZ,
  claim_expires_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One live entry per user per event. Partial, so a user whose claim expired
  -- can rejoin the back of the waitlist later without the constraint blocking
  -- them, while a double-join while still waiting is refused by the database.
  CONSTRAINT waitlist_no_duplicate_live
    EXCLUDE (event_id WITH =, user_id WITH =) WHERE (status IN ('waiting', 'notified'))
);

-- The notify query: oldest 'waiting' entry for an event. FIFO here is correct and
-- deliberately unlike the sale queue's lottery — a waitlist is a promise made in
-- arrival order, not a contest for simultaneously-released inventory.
CREATE INDEX idx_waitlist_next ON waitlist (event_id, created_at) WHERE status = 'waiting';

-- Sweeper query for claim windows that ran out.
CREATE INDEX idx_waitlist_claims ON waitlist (claim_expires_at) WHERE status = 'notified';

CREATE TABLE payments (
  id              BIGSERIAL PRIMARY KEY,
  booking_id      BIGINT NOT NULL REFERENCES bookings(id),
  provider_ref    TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount          NUMERIC(10, 2) NOT NULL,
  status          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replay ledger for provider webhooks (Week 6 Day 2). Stripe retries until it
-- gets a 2xx, so the same event id arrives repeatedly and MUST produce one state
-- change. UNIQUE (provider, event_id) makes that the database's job rather than
-- the handler's: the insert either wins and processing proceeds, or it raises
-- 23505 and the delivery is a no-op ack.
--
-- Keyed on the provider's event id, not on a hash of the body — Stripe resends
-- the same event id with a byte-identical body, but keying on content would also
-- collapse two genuinely distinct events that happened to look alike.
CREATE TABLE webhook_events (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  type          TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

CREATE TABLE outbox (
  id            BIGSERIAL PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id   BIGINT NOT NULL,
  payload        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ
);

CREATE INDEX idx_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
