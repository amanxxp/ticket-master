import pool from "../config/db.js";
import { ACTIVE_QUEUES_KEY } from "../../../shared/queue.js";

export const claimStalePendingPayments = async (client, olderThanSeconds, limit = 50) => {
    const { rows } = await client.query(
        `SELECT id, booking_id AS "bookingId", amount, status,
                provider_ref AS "providerRef", idempotency_key AS "idempotencyKey"
         FROM payments
         WHERE status = 'pending' AND created_at < now() - make_interval(secs => $1::int)
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [olderThanSeconds, limit]
    );
    return rows;
};

export const markPaymentStatus = async (client, paymentId, nextStatus, fromStatuses, providerRef) => {
    const { rows } = await client.query(
        `UPDATE payments SET status = $2, provider_ref = COALESCE($4, provider_ref)
          WHERE id = $1 AND status = ANY($3::text[])
        RETURNING id, status`,
        [paymentId, nextStatus, fromStatuses, providerRef ?? null]
    );
    return rows[0] ?? null;
};

export const lockBooking = async (client, bookingId) => {
    const { rows } = await client.query(
        `SELECT id, event_id AS "eventId", status FROM bookings WHERE id = $1 FOR UPDATE`,
        [bookingId]
    );
    return rows[0] ?? null;
};

export const getBookedTicketIds = async (client, bookingId) => {
    const { rows } = await client.query(
        `SELECT ticket_id AS "ticketId" FROM booking_items WHERE booking_id = $1 ORDER BY ticket_id`,
        [bookingId]
    );
    return rows.map((r) => r.ticketId);
};

export const releaseBookedTickets = async (client, bookingId, ticketIds) => {
    await client.query(`DELETE FROM booking_items WHERE booking_id = $1`, [bookingId]);
    const { rows } = await client.query(
        `UPDATE tickets SET status = 'available'
          WHERE id = ANY($1::bigint[]) AND status = 'booked' RETURNING id`,
        [ticketIds]
    );
    return rows.map((r) => r.id);
};

export const markBookingStatus = async (client, bookingId, nextStatus, fromStatuses) => {
    const { rows } = await client.query(
        `UPDATE bookings SET status = $2 WHERE id = $1 AND status = ANY($3::text[]) RETURNING id, status`,
        [bookingId, nextStatus, fromStatuses]
    );
    return rows[0] ?? null;
};

export const insertOutboxEvent = async (client, { aggregateType, aggregateId, payload }) => {
    await client.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3)`,
        [aggregateType, aggregateId, payload]
    );
};

export const expireLapsedClaims = async (client, limit = 100) => {
    const { rows } = await client.query(
        `UPDATE waitlist SET status = 'expired'
          WHERE id IN (
            SELECT id FROM waitlist
             WHERE status = 'notified' AND claim_expires_at < now()
             ORDER BY claim_expires_at FOR UPDATE SKIP LOCKED LIMIT $1
          )
        RETURNING id, event_id AS "eventId", user_id AS "userId"`,
        [limit]
    );
    return rows;
};

// Discovered from the same active-events registry the admitter uses, rather than
// KEYS/SCAN over the keyspace — scanning a live Redis is a maintenance operation,
// not something a worker should do every tick.
//
// Falls back to querying Postgres for events with recent bookings, because an
// event can hold stale hold-keys after its queue has already been deregistered.
export const listEventsWithHolds = async (redis) => {
    const fromRegistry = await redis.sMembers(ACTIVE_QUEUES_KEY);
    const { rows } = await pool.query(
        `SELECT DISTINCT event_id::text AS id FROM bookings
         WHERE created_at > now() - interval '1 day'`
    );
    return [...new Set([...fromRegistry, ...rows.map((r) => r.id)])];
};

export const listBookedTicketIds = async (eventId, candidateIds) => {
    const { rows } = await pool.query(
        `SELECT id::text FROM tickets
         WHERE event_id = $1 AND id = ANY($2::bigint[]) AND status = 'booked'`,
        [eventId, candidateIds]
    );
    return rows.map((r) => r.id);
};
