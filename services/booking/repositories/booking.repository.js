import pool from "../config/db.js";

// Locks the requested rows in a deterministic order.
//
// ORDER BY id is the whole point: two concurrent requests for {A,B} and {B,A}
// that locked in arrival order would each hold one row and wait for the other —
// a deadlock Postgres resolves by killing one with 40P01. Sorting the lock
// acquisition means every transaction walks the same rows in the same direction,
// so the second one simply waits.
//
// No status predicate here. The lock has to cover the row whatever its current
// state, because the decision about bookability is made after the lock is held,
// against freshly committed data.
export const lockTicketsForBooking = async (client, eventId, ticketIds) => {
    const { rows } = await client.query(
        `SELECT id, event_id AS "eventId", seat, price, status
         FROM tickets
         WHERE id = ANY($1::bigint[]) AND event_id = $2
         ORDER BY id
         FOR UPDATE`,
        [ticketIds, eventId]
    );
    return rows;
};

// The primary guard: a compare-and-swap. `status = 'available'` in the WHERE
// clause is the compare, and the returned row count is how we detect a lost
// race. Under READ COMMITTED, a blocked UPDATE re-evaluates its predicate
// against the winner's committed row, so the loser matches zero rows rather
// than overwriting a booked seat.
export const bookTickets = async (client, eventId, ticketIds) => {
    const { rows } = await client.query(
        `UPDATE tickets
         SET status = 'booked'
         WHERE id = ANY($1::bigint[]) AND event_id = $2 AND status = 'available'
         RETURNING id, price`,
        [ticketIds, eventId]
    );
    return rows;
};

// Guard-removal variant, reached only via BOOKING_DISABLE_ROWCOUNT_GUARD. Drops
// the `status = 'available'` compare so the CAS cannot fail, which is what lets
// the acceptance test prove UNIQUE(ticket_id) blocks the double-book on its own.
export const bookTicketsUnguarded = async (client, eventId, ticketIds) => {
    const { rows } = await client.query(
        `UPDATE tickets
         SET status = 'booked'
         WHERE id = ANY($1::bigint[]) AND event_id = $2
         RETURNING id, price`,
        [ticketIds, eventId]
    );
    return rows;
};

export const insertBooking = async (client, { userId, eventId, status, totalAmount }) => {
    const { rows } = await client.query(
        `INSERT INTO bookings (user_id, event_id, status, total_amount)
         VALUES ($1, $2, $3, $4)
         RETURNING id, user_id AS "userId", event_id AS "eventId", status,
                   total_amount AS "totalAmount", created_at AS "createdAt"`,
        [userId, eventId, status, totalAmount]
    );
    return rows[0];
};

// The backstop. UNIQUE(ticket_id) means the database itself refuses a second
// booking for a ticket even if both guards above were removed or buggy. One
// statement so a partial insert is impossible.
export const insertBookingItems = async (client, bookingId, ticketIds) => {
    const { rows } = await client.query(
        `INSERT INTO booking_items (booking_id, ticket_id)
         SELECT $1, ticket_id
         FROM unnest($2::bigint[]) AS t(ticket_id)
         RETURNING id, ticket_id AS "ticketId"`,
        [bookingId, ticketIds]
    );
    return rows;
};

export const insertOutboxEvent = async (client, { aggregateType, aggregateId, payload }) => {
    const { rows } = await client.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, payload)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [aggregateType, aggregateId, payload]
    );
    return rows[0];
};

export const getEventForBooking = async (client, eventId) => {
    const { rows } = await client.query(
        `SELECT id, max_tickets_per_user AS "maxTicketsPerUser"
         FROM events
         WHERE id = $1 AND NOT is_deleted`,
        [eventId]
    );
    return rows[0] ?? null;
};

// Reserve's Postgres half. No lock and no FOR UPDATE: a hold is not a claim on
// the row, so there is nothing to serialize here. Its only job is to reject
// requests that could never succeed — unknown ticket, wrong event, already sold —
// before the Lua script runs.
//
// A seat could be sold between this read and the claim. That is intentionally not
// guarded: the hold would then point at a booked seat, the seat map still renders
// it `booked` (booked outranks held), and confirm re-checks `status = 'available'`
// under a row lock. The hold is an optimization; Postgres stays the arbiter.
export const getTicketsForHold = async (eventId, ticketIds) => {
    const { rows } = await pool.query(
        `SELECT id, status
         FROM tickets
         WHERE id = ANY($1::bigint[]) AND event_id = $2`,
        [ticketIds, eventId]
    );
    return rows;
};

// Counts toward the per-user cap alongside live Redis holds. `pending` is
// included because a booking mid-payment has not been given up — excluding it
// would let a user park inventory in unpaid bookings and reserve past the cap.
export const countUserTicketsForEvent = async (userId, eventId) => {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS count
         FROM booking_items bi
         JOIN bookings b ON b.id = bi.booking_id
         JOIN tickets t ON t.id = bi.ticket_id
         WHERE b.user_id = $1
           AND t.event_id = $2
           AND b.status IN ('confirmed', 'pending')`,
        [userId, eventId]
    );
    return rows[0].count;
};

export const getEvent = async (eventId) => {
    const { rows } = await pool.query(
        `SELECT id, max_tickets_per_user AS "maxTicketsPerUser"
         FROM events
         WHERE id = $1 AND NOT is_deleted`,
        [eventId]
    );
    return rows[0] ?? null;
};

export const getBookingById = async (bookingId) => {
    const { rows } = await pool.query(
        `SELECT b.id, b.user_id AS "userId", b.event_id AS "eventId", b.status,
                b.total_amount AS "totalAmount", b.created_at AS "createdAt",
                coalesce(
                    json_agg(json_build_object('ticketId', t.id, 'seat', t.seat, 'price', t.price)
                             ORDER BY t.id)
                    FILTER (WHERE t.id IS NOT NULL),
                    '[]'
                ) AS tickets
         FROM bookings b
         LEFT JOIN booking_items bi ON bi.booking_id = b.id
         LEFT JOIN tickets t ON t.id = bi.ticket_id
         WHERE b.id = $1
         GROUP BY b.id`,
        [bookingId]
    );
    return rows[0] ?? null;
};
