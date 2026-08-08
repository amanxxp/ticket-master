import pool from "../config/db.js";

export const UNIQUE_VIOLATION = "23505";

// Written BEFORE the provider is called, inside the same transaction as the
// booking. A crash between this insert and the charge therefore leaves a
// `pending` row the reconciler can find and resolve against Stripe; the reverse
// order would leave money moved with nothing in the database pointing at it, and
// nothing to sweep.
//
// `idempotency_key` is UNIQUE, so this insert is also the concurrency guard: two
// simultaneous confirms of the same booking cannot both create a payment intent.
// The loser gets 23505 and reads the winner's row.
export const insertPendingPayment = async (client, { bookingId, amount, idempotencyKey }) => {
    const { rows } = await client.query(
        `INSERT INTO payments (booking_id, amount, idempotency_key, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING id, booking_id AS "bookingId", amount, idempotency_key AS "idempotencyKey",
                   status, provider_ref AS "providerRef", created_at AS "createdAt"`,
        [bookingId, amount, idempotencyKey]
    );
    return rows[0];
};

export const findPaymentByIdempotencyKey = async (idempotencyKey) => {
    const { rows } = await pool.query(
        `SELECT id, booking_id AS "bookingId", amount, status,
                provider_ref AS "providerRef", idempotency_key AS "idempotencyKey"
         FROM payments WHERE idempotency_key = $1`,
        [idempotencyKey]
    );
    return rows[0] ?? null;
};

export const findPaymentByBooking = async (client, bookingId) => {
    const runner = client ?? pool;
    const { rows } = await runner.query(
        `SELECT id, booking_id AS "bookingId", amount, status,
                provider_ref AS "providerRef", idempotency_key AS "idempotencyKey"
         FROM payments WHERE booking_id = $1 ORDER BY id DESC LIMIT 1`,
        [bookingId]
    );
    return rows[0] ?? null;
};

// Status transitions are guarded by `fromStatuses` rather than written blindly.
// This is what makes out-of-order webhook delivery safe: a late `succeeded`
// arriving after a `refunded` matches no allowed source state, changes nothing,
// and returns null so the caller can log it instead of corrupting the row.
export const markPaymentStatus = async (client, paymentId, nextStatus, fromStatuses, providerRef) => {
    const runner = client ?? pool;
    const { rows } = await runner.query(
        `UPDATE payments
            SET status = $2,
                provider_ref = COALESCE($4, provider_ref)
          WHERE id = $1 AND status = ANY($3::text[])
        RETURNING id, status, provider_ref AS "providerRef"`,
        [paymentId, nextStatus, fromStatuses, providerRef ?? null]
    );
    return rows[0] ?? null;
};

// The reconciler's input (Week 6 Day 4). SKIP LOCKED so several reconciler
// instances can sweep concurrently without both claiming the same row, matching
// the outbox poller's pattern.
export const claimStalePendingPayments = async (client, olderThanSeconds, limit = 50) => {
    const { rows } = await client.query(
        `SELECT id, booking_id AS "bookingId", amount, status,
                provider_ref AS "providerRef", idempotency_key AS "idempotencyKey",
                created_at AS "createdAt"
         FROM payments
         WHERE status = 'pending'
           AND created_at < now() - make_interval(secs => $1::int)
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [olderThanSeconds, limit]
    );
    return rows;
};
