import pool from "../config/db.js";
import redis from "../config/redis.js";
import { readLiveHolds } from "../../../shared/availability.js";

// The same "effective availability" question Event Service's seatmap answers
// (Postgres status merged with live Redis holds), asked here for a different
// reason: the admit budget must not count a ticket that is `available` in
// Postgres but currently held — that ticket is spoken for, even though no
// booking has happened yet. Counting it toward budget would admit more people
// than there is real remaining inventory to sell them.
export const countAvailableTickets = async (eventId) => {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS count FROM tickets WHERE event_id = $1 AND status = 'available'`,
        [eventId]
    );
    const availableInDb = rows[0].count;

    const holds = await readLiveHolds(redis, eventId);
    return Math.max(0, availableInDb - holds.size);
};
