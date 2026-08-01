import pool from "../config/db.js";

const columns = (prefix = "") => `${prefix}id, ${prefix}event_id AS "eventId",
    ${prefix}seat, ${prefix}price, ${prefix}status,
    ${prefix}created_at AS "createdAt"`;

const TICKET_COLUMNS = columns("t.");
const RETURNING_COLUMNS = columns();

// One statement per chunk regardless of seat count — UNNEST passes three arrays
// as three params instead of 3×N placeholders, which keeps a 50k-seat mint from
// blowing past the wire protocol's parameter limit.
// ON CONFLICT DO NOTHING makes a retried mint idempotent: the seats that already
// exist are skipped, and only the newly created rows come back, so the caller can
// report created-vs-skipped instead of failing the whole batch on one duplicate.
export const insertTickets = async (client, eventId, tickets) => {
    const CHUNK = 5000;
    const created = [];
    for (let i = 0; i < tickets.length; i += CHUNK) {
        const chunk = tickets.slice(i, i + CHUNK);
        const { rows } = await client.query(
            `INSERT INTO tickets (event_id, seat, price)
             SELECT $1, seat, price
             FROM unnest($2::text[], $3::numeric[]) AS s(seat, price)
             ON CONFLICT (event_id, seat) DO NOTHING
             RETURNING ${RETURNING_COLUMNS}`,
            [eventId, chunk.map((t) => t.seat), chunk.map((t) => t.price)]
        );
        created.push(...rows);
    }
    return created;
};

// Keyset paginated on id. The (event_id, status) index from the schema serves
// the filtered form; the unfiltered form still range-scans on it by event_id.
export const getTicketsByEvent = async ({ eventId, cursor = "0", pageSize = 50, status }) => {
    const { rows } = await pool.query(
        `SELECT ${TICKET_COLUMNS} FROM tickets t
         WHERE t.event_id = $1
           AND t.id > $2
           AND ($3::text IS NULL OR t.status = $3)
         ORDER BY t.id ASC
         LIMIT $4`,
        [eventId, cursor, status ?? null, pageSize]
    );
    const nextCursor = rows.length === Number(pageSize) ? rows[rows.length - 1].id : null;
    return { rows, nextCursor };
};

// Unpaginated by design: the seat map is defined as *every* ticket for the
// event, so there is no page boundary to keyset over. Served by the same
// idx_tickets_event_status index as the filtered list read.
export const getAllTicketsForEvent = async (eventId) => {
    const { rows } = await pool.query(
        `SELECT ${TICKET_COLUMNS} FROM tickets t
         WHERE t.event_id = $1
         ORDER BY t.id ASC`,
        [eventId]
    );
    return rows;
};

// Bounded lookup for the stream's delta push — one pub/sub message names the
// handful of tickets that changed, not the whole event. `id = ANY` over a small
// array rather than N single-ticket queries.
export const getTicketsByIds = async (eventId, ticketIds) => {
    const { rows } = await pool.query(
        `SELECT ${TICKET_COLUMNS} FROM tickets t
         WHERE t.event_id = $1 AND t.id = ANY($2::bigint[])`,
        [eventId, ticketIds]
    );
    return rows;
};

// event_id is in the predicate, not just the id: without it a caller could read
// any ticket in the system through an unrelated event's URL.
export const getTicketById = async (eventId, ticketId) => {
    const { rows } = await pool.query(
        `SELECT ${TICKET_COLUMNS} FROM tickets t
         WHERE t.id = $1 AND t.event_id = $2`,
        [ticketId, eventId]
    );
    return rows[0] ?? null;
};

export const lockTicket = async (client, eventId, ticketId) => {
    const { rows } = await client.query(
        `SELECT id, status FROM tickets
         WHERE id = $1 AND event_id = $2 FOR UPDATE`,
        [ticketId, eventId]
    );
    return rows[0] ?? null;
};

// Price only. status is not settable here by design — see ticket.validator.js.
export const updateTicketPrice = async (client, eventId, ticketId, price) => {
    const { rows } = await client.query(
        `UPDATE tickets SET price = $3
         WHERE id = $1 AND event_id = $2
         RETURNING ${RETURNING_COLUMNS}`,
        [ticketId, eventId, price]
    );
    return rows[0] ?? null;
};

// Hard delete: a ticket is inventory, not a record of intent. Nothing needs the
// row's history once it is gone, and a soft flag would have to be threaded into
// every availability query as a second way to be unavailable. Sold tickets are
// never reachable here — the service refuses them before this runs, and
// booking_items' FK is the backstop if it somehow does.
export const deleteTicket = async (client, eventId, ticketId) => {
    const { rows } = await client.query(
        `DELETE FROM tickets
         WHERE id = $1 AND event_id = $2 AND status = 'available'
         RETURNING id`,
        [ticketId, eventId]
    );
    return rows[0] ?? null;
};

export const countBookingItemsForTicket = async (client, ticketId) => {
    const { rows } = await client.query(
        `SELECT count(*)::int AS count FROM booking_items WHERE ticket_id = $1`,
        [ticketId]
    );
    return rows[0].count;
};

// seat_map lives on the venue, so minting inventory has to go through the event.
export const getSeatMapForEvent = async (client, eventId) => {
    const { rows } = await client.query(
        `SELECT v.seat_map AS "seatMap"
         FROM events e
         JOIN venues v ON v.id = e.venue_id
         WHERE e.id = $1 AND NOT e.is_deleted`,
        [eventId]
    );
    return rows[0]?.seatMap ?? null;
};
