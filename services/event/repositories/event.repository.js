import pool from "../config/db.js";

// Two variants of the same projection: the prefixed one for queries that join
// (where a bare column name would be ambiguous), the plain one for INSERT/UPDATE
// RETURNING clauses, which have no table alias in scope.
const columns = (prefix = "") => `${prefix}id, ${prefix}name, ${prefix}description,
    ${prefix}venue_id AS "venueId", ${prefix}performer_id AS "performerId",
    ${prefix}event_date AS "eventDate",
    ${prefix}max_tickets_per_user AS "maxTicketsPerUser",
    ${prefix}created_at AS "createdAt"`;

const EVENT_COLUMNS = columns("e.");
const RETURNING_COLUMNS = columns();

// Write paths take an explicit client so the caller can put them in the same
// transaction as the outbox row. Reads use the pool directly.
export const insertEvent = async (client, { name, description, venueId, performerId, eventDate, maxTicketsPerUser }) => {
    const { rows } = await client.query(
        `INSERT INTO events (name, description, venue_id, performer_id, event_date, max_tickets_per_user)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${RETURNING_COLUMNS}`,
        [name, description, venueId, performerId, eventDate, maxTicketsPerUser]
    );
    return rows[0];
};

export const getEvents = async ({ cursorDate, cursorId, pageSize = 10, venueId, performerId, upcoming = true }) => {
    const { rows } = await pool.query(
        `SELECT ${EVENT_COLUMNS} FROM events e
         WHERE NOT e.is_deleted
           AND ($1::timestamptz IS NULL OR (e.event_date, e.id) > ($1, $2::bigint))
           AND ($3::bigint IS NULL OR e.venue_id = $3)
           AND ($4::bigint IS NULL OR e.performer_id = $4)
           AND ($5 = false OR e.event_date >= now())
         ORDER BY e.event_date ASC, e.id ASC
         LIMIT $6`,
        [cursorDate ?? null, cursorId ?? null, venueId ?? null, performerId ?? null, upcoming, pageSize]
    );
    // A short page means the scan reached the end — emitting a cursor there
    // would send the client back for a page that is always empty.
    const last = rows[rows.length - 1];
    const nextCursor = rows.length === Number(pageSize)
        ? { cursorDate: last.eventDate, cursorId: last.id }
        : null;
    return { rows, nextCursor };
};

// Inner joins, deliberately without a `NOT v.is_deleted` filter: a retired venue
// must not make its events vanish, since those events still have tickets sold.
// seat_map is excluded — it is the largest column here and GET /events/:id/seatmap owns it.
export const getEventById = async (id) => {
    const { rows } = await pool.query(
        `SELECT ${EVENT_COLUMNS},
                json_build_object('id', v.id, 'name', v.name, 'location', v.location) AS venue,
                json_build_object('id', p.id, 'name', p.name) AS performer
         FROM events e
         JOIN venues v ON v.id = e.venue_id
         JOIN performers p ON p.id = e.performer_id
         WHERE e.id = $1 AND NOT e.is_deleted`,
        [id]
    );
    return rows[0] ?? null;
};

// COALESCE lets one statement serve partial updates without string-building SQL.
// Explicit casts are required: an untyped NULL param leaves Postgres unable to
// infer the type. `description` is intentionally not COALESCEd — clearing it to
// NULL is a legal edit, so it uses a separate "was this key sent" flag.
export const updateEvent = async (client, id, changes) => {
    const { name, description, venueId, performerId, eventDate, maxTicketsPerUser } = changes;
    const { rows } = await client.query(
        `UPDATE events SET
            name                 = COALESCE($2::text, name),
            description          = CASE WHEN $3 THEN $4::text ELSE description END,
            venue_id             = COALESCE($5::bigint, venue_id),
            performer_id         = COALESCE($6::bigint, performer_id),
            event_date           = COALESCE($7::timestamptz, event_date),
            max_tickets_per_user = COALESCE($8::int, max_tickets_per_user)
         WHERE id = $1 AND NOT is_deleted
         RETURNING ${RETURNING_COLUMNS}`,
        [
            id,
            name ?? null,
            Object.hasOwn(changes, "description"),
            description ?? null,
            venueId ?? null,
            performerId ?? null,
            eventDate ?? null,
            maxTicketsPerUser ?? null,
        ]
    );
    return rows[0] ?? null;
};

export const softDeleteEvent = async (client, id) => {
    const { rows } = await client.query(
        `UPDATE events SET is_deleted = true
         WHERE id = $1 AND NOT is_deleted
         RETURNING id`,
        [id]
    );
    return rows[0] ?? null;
};

// Takes the row lock the guard counts depend on. Returns null when the event is
// missing or already deleted, so callers can 404 before doing more work.
export const lockEvent = async (client, id) => {
    const { rows } = await client.query(
        `SELECT id FROM events WHERE id = $1 AND NOT is_deleted FOR UPDATE`,
        [id]
    );
    return rows[0] ?? null;
};

export const venueExistsActive = async (client, id) => {
    const { rows } = await client.query(
        `SELECT 1 FROM venues WHERE id = $1 AND NOT is_deleted`,
        [id]
    );
    return rows.length > 0;
};

export const performerExists = async (client, id) => {
    const { rows } = await client.query(
        `SELECT 1 FROM performers WHERE id = $1`,
        [id]
    );
    return rows.length > 0;
};

export const countBookedTickets = async (client, id) => {
    const { rows } = await client.query(
        `SELECT count(*)::int AS count FROM tickets
         WHERE event_id = $1 AND status = 'booked'`,
        [id]
    );
    return rows[0].count;
};

export const countLiveBookings = async (client, id) => {
    const { rows } = await client.query(
        `SELECT count(*)::int AS count FROM bookings
         WHERE event_id = $1 AND status IN ('pending', 'confirmed')`,
        [id]
    );
    return rows[0].count;
};
