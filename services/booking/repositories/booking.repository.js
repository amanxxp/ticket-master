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
        `SELECT id,
                max_tickets_per_user AS "maxTicketsPerUser",
                queue_mode           AS "queueMode",
                sale_opens_at        AS "saleOpensAt",
                draw_seed            AS "drawSeed"
         FROM events
         WHERE id = $1 AND NOT is_deleted`,
        [eventId]
    );
    return rows[0] ?? null;
};

// Publishes the lottery seed exactly once, and only once sale_opens_at has
// passed. Both halves matter:
//
// `draw_seed IS NULL` makes this a compare-and-swap — concurrent first requests
// after sale-open race here, one wins, and every loser reads the winner's seed
// back out of the returned row. A read-then-write would let two callers generate
// two seeds and score the same user twice, differently.
//
// `now() >= sale_opens_at` is evaluated by Postgres, not by the caller, so the
// seed cannot be coaxed into existing early by a client (or a service) with a
// fast clock. Before that moment the seed does not exist anywhere to be leaked,
// which is the entire basis of "unguessable pre-open" — not the strength of the
// hash, but the absence of its input.
export const claimDrawSeed = async (eventId, seed) => {
    const { rows } = await pool.query(
        `UPDATE events
            SET draw_seed = $2
          WHERE id = $1
            AND draw_seed IS NULL
            AND sale_opens_at IS NOT NULL
            AND now() >= sale_opens_at
        RETURNING draw_seed AS "drawSeed"`,
        [eventId, seed]
    );
    return rows[0]?.drawSeed ?? null;
};

// ---------------------------------------------------------------- cancellation

// Locks the booking row before anything reads its status. Without the lock two
// concurrent cancels both read 'confirmed', both proceed, and the seat is
// released twice — the second release re-opening a seat somebody else has since
// bought. Same shape as the confirm path's row lock, for the same reason.
export const lockBookingForCancel = async (client, bookingId) => {
    const { rows } = await client.query(
        `SELECT id, user_id AS "userId", event_id AS "eventId", status,
                total_amount AS "totalAmount"
         FROM bookings
         WHERE id = $1
         FOR UPDATE`,
        [bookingId]
    );
    return rows[0] ?? null;
};

export const getBookedTicketIds = async (client, bookingId) => {
    const { rows } = await client.query(
        `SELECT ticket_id AS "ticketId"
         FROM booking_items
         WHERE booking_id = $1
         ORDER BY ticket_id`,
        [bookingId]
    );
    return rows.map((r) => r.ticketId);
};

// The rows are DELETEd, not flagged. `UNIQUE (ticket_id)` on booking_items means
// a surviving row would block the seat from ever being sold again — the resale
// path is the reason, exactly as argued in DECISIONS.md #5. The audit trail is
// not lost: `bookings` keeps the cancelled row with its total, and the outbox
// keeps the event.
export const releaseBookedTickets = async (client, bookingId, ticketIds) => {
    await client.query(`DELETE FROM booking_items WHERE booking_id = $1`, [bookingId]);

    // `status = 'booked'` in the WHERE is a guard, not decoration: if a ticket is
    // somehow already 'available', this returns fewer rows than asked and the
    // caller can tell rather than silently double-releasing.
    const { rows } = await client.query(
        `UPDATE tickets
            SET status = 'available'
          WHERE id = ANY($1::bigint[]) AND status = 'booked'
        RETURNING id`,
        [ticketIds]
    );
    return rows.map((r) => r.id);
};

// Guarded on the current status so the transition can only happen once even if
// the row lock above were removed — the same belt-and-braces habit as the confirm
// path's three layers.
export const markBookingStatus = async (client, bookingId, nextStatus, fromStatuses) => {
    const { rows } = await client.query(
        `UPDATE bookings
            SET status = $2
          WHERE id = $1 AND status = ANY($3::text[])
        RETURNING id, status`,
        [bookingId, nextStatus, fromStatuses]
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
