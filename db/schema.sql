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

CREATE TABLE payments (
  id              BIGSERIAL PRIMARY KEY,
  booking_id      BIGINT NOT NULL REFERENCES bookings(id),
  provider_ref    TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount          NUMERIC(10, 2) NOT NULL,
  status          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
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
