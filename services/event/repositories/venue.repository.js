import pool from "../config/db.js";

// Soft-deleted venues stay in the table because events reference them by FK.
const VENUE_COLUMNS = `id, name, location, seat_map AS "seatMap", created_at AS "createdAt"`;

export const insertVenue = async ({ name, location, seatMap }) => {
    const { rows } = await pool.query(
        `INSERT INTO venues (name, location, seat_map)
         VALUES ($1, $2, $3)
         RETURNING ${VENUE_COLUMNS}`,
        [name, location, seatMap]
    );
    return rows[0];
};

// Route-level validation normally supplies both, but the defaults keep a direct
// service call from turning into `LIMIT NULL`.
export const getVenues = async ({ cursor = "0", pageSize = 10 }) => {
    const { rows } = await pool.query(
        `SELECT ${VENUE_COLUMNS} FROM venues
         WHERE id > $1 AND NOT is_deleted
         ORDER BY id ASC LIMIT $2`,
        [cursor, pageSize]
    );
    // A short page means the scan reached the end — emitting a cursor there
    // would send the client back for a page that is always empty.
    const nextCursor = rows.length === pageSize ? rows[rows.length - 1].id : null;
    return { rows, nextCursor };
};

export const getVenueById = async (id) => {
    const { rows } = await pool.query(
        `SELECT ${VENUE_COLUMNS} FROM venues
         WHERE id = $1 AND NOT is_deleted`,
        [id]
    );
    return rows[0] ?? null;
};

export const updateVenue = async (id, { name, location, seatMap }) => {
    // COALESCE lets one statement serve partial updates without string-building SQL.
    const { rows } = await pool.query(
        `UPDATE venues
         SET name     = COALESCE($2::text, name),
             location = COALESCE($3::text, location),
             seat_map = COALESCE($4::jsonb, seat_map)
         WHERE id = $1 AND NOT is_deleted
         RETURNING ${VENUE_COLUMNS}`,
        [id, name ?? null, location ?? null, seatMap ?? null]
    );
    return rows[0] ?? null;
};

export const softDeleteVenue = async (id) => {
    const { rows } = await pool.query(
        `UPDATE venues
         SET is_deleted = true
         WHERE id = $1 AND NOT is_deleted
         RETURNING id`,
        [id]
    );
    return rows[0] ?? null;
};

// Guards deletion: events keep an FK to the venue, so removing one out from
// under a live event would leave that event unservable.
export const countActiveEventsForVenue = async (id) => {
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM events
         WHERE venue_id = $1 AND NOT is_deleted`,
        [id]
    );
    return rows[0].count;
};
