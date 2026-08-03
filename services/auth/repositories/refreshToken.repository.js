import pool from "../config/db.js";

export const insertRefreshToken = async ({ userId, tokenHash, expiresAt }) => {
    await pool.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, tokenHash, expiresAt]
    );
};

// Active means: exists, not explicitly revoked (logout), not past its own
// expiry. Any one of those failing is the same answer to the caller (401) —
// this query just folds all three into "found" or "not found".
export const getActiveRefreshToken = async (tokenHash) => {
    const { rows } = await pool.query(
        `SELECT user_id AS "userId" FROM refresh_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [tokenHash]
    );
    return rows[0] ?? null;
};

// Idempotent by construction: revoking an already-revoked or nonexistent hash
// just updates zero rows rather than erroring, so logout never needs to check
// existence first.
export const revokeRefreshToken = async (tokenHash) => {
    await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash]
    );
};
