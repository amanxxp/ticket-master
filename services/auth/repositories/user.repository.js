import pool from "../config/db.js";

const USER_COLUMNS = `id, email, role, created_at AS "createdAt"`;

// role is never a parameter here — it is hardcoded 'user' at the call site in
// auth.service.js, not accepted from the request body. Self-registration must
// not be a privilege-escalation path; nothing in this system grants
// organizer/admin except a manual promotion outside this API.
export const insertUser = async ({ email, passwordHash }) => {
    const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, 'user')
         RETURNING ${USER_COLUMNS}`,
        [email, passwordHash]
    );
    return rows[0];
};

// Includes password_hash — the one place in this repository that's allowed to
// return it, since login is the one caller that needs it to compare against.
export const getUserByEmail = async (email) => {
    const { rows } = await pool.query(
        `SELECT id, email, role, password_hash AS "passwordHash", created_at AS "createdAt"
         FROM users WHERE email = $1`,
        [email]
    );
    return rows[0] ?? null;
};

// No password_hash — refresh reads the user's current role (which may have
// changed since login) but has no reason to ever see the hash again.
export const getUserById = async (id) => {
    const { rows } = await pool.query(
        `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
        [id]
    );
    return rows[0] ?? null;
};
