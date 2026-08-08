import pool from "../config/db.js";

// Postgres raises 23P01 when the EXCLUDE constraint refuses a second live entry
// for the same (event, user). That is a duplicate join, not a server fault.
export const EXCLUSION_VIOLATION = "23P01";

export const joinWaitlist = async (eventId, userId) => {
    const { rows } = await pool.query(
        `INSERT INTO waitlist (event_id, user_id)
         VALUES ($1, $2)
         RETURNING id, event_id AS "eventId", user_id AS "userId", status,
                   created_at AS "createdAt"`,
        [eventId, userId]
    );
    return rows[0];
};

// Position among live entries, for the caller's own information. Counts
// 'notified' entries too — someone holding an unexpired claim is still ahead of
// you, and reporting otherwise would show a position that later worsens.
export const getWaitlistPosition = async (eventId, userId) => {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS position
         FROM waitlist
         WHERE event_id = $1
           AND status IN ('waiting', 'notified')
           AND created_at <= (
             SELECT created_at FROM waitlist
             WHERE event_id = $1 AND user_id = $2 AND status IN ('waiting', 'notified')
           )`,
        [eventId, userId]
    );
    return rows[0]?.position ?? null;
};

// Claims the next waiting entry and opens its claim window, in ONE statement.
//
// `FOR UPDATE SKIP LOCKED` inside the subquery is what makes "exactly one
// waitlist user is notified per released ticket" true under concurrency. Two
// cancellations releasing two tickets at the same instant both run this: the
// first locks the head row, the second SKIPs it and takes the next one. A
// SELECT-then-UPDATE pair would let both read the same head row and notify one
// user twice while the second user is never told at all.
//
// `LIMIT 1` plus one call per released ticket, rather than notifying N at once,
// because each ticket is a separate promise with its own claim window — batching
// them would give several users one shared deadline for one shared seat.
export const notifyNextWaitlisted = async (client, eventId, claimWindowSeconds) => {
    const { rows } = await client.query(
        `UPDATE waitlist
            SET status = 'notified',
                notified_at = now(),
                claim_expires_at = now() + make_interval(secs => $2::int)
          WHERE id = (
            SELECT id FROM waitlist
             WHERE event_id = $1 AND status = 'waiting'
             ORDER BY created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
        RETURNING id, user_id AS "userId", claim_expires_at AS "claimExpiresAt"`,
        [eventId, claimWindowSeconds]
    );
    return rows[0] ?? null;
};

// A notified user's window ran out. Their entry is terminal ('expired') rather
// than returned to 'waiting' — silently re-queueing someone who already had
// their chance would starve everyone behind them on every release.
export const expireLapsedClaims = async (client, limit = 100) => {
    const { rows } = await client.query(
        `UPDATE waitlist
            SET status = 'expired'
          WHERE id IN (
            SELECT id FROM waitlist
             WHERE status = 'notified' AND claim_expires_at < now()
             ORDER BY claim_expires_at
             FOR UPDATE SKIP LOCKED
             LIMIT $1
          )
        RETURNING id, event_id AS "eventId", user_id AS "userId"`,
        [limit]
    );
    return rows;
};

// Called when a notified user actually books. Guarded on status so a user whose
// window lapsed between the reserve and the confirm cannot mark it claimed.
export const markClaimed = async (client, eventId, userId) => {
    const { rows } = await client.query(
        `UPDATE waitlist
            SET status = 'claimed'
          WHERE event_id = $1 AND user_id = $2 AND status = 'notified'
            AND claim_expires_at >= now()
        RETURNING id`,
        [eventId, userId]
    );
    return rows[0] ?? null;
};

export const getLiveEntry = async (eventId, userId) => {
    const { rows } = await pool.query(
        `SELECT id, status, claim_expires_at AS "claimExpiresAt"
         FROM waitlist
         WHERE event_id = $1 AND user_id = $2 AND status IN ('waiting', 'notified')`,
        [eventId, userId]
    );
    return rows[0] ?? null;
};

export const leaveWaitlist = async (eventId, userId) => {
    const { rows } = await pool.query(
        `UPDATE waitlist
            SET status = 'cancelled'
          WHERE event_id = $1 AND user_id = $2 AND status IN ('waiting', 'notified')
        RETURNING id`,
        [eventId, userId]
    );
    return rows[0] ?? null;
};
