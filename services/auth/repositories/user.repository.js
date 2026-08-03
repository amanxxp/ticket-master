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

// Unlike insertUser, role IS a parameter — this is the admin-only path
// (services/auth/services/auth.service.js#adminCreateUser), gated at the
// gateway to `roles: ["admin"]` before it ever reaches here. Kept as a
// separate function rather than an optional param on insertUser so the
// privileged path is never one flag away from being reachable by accident
// from the public register() call site.
export const insertUserWithRole = async ({ email, passwordHash, role }) => {
    const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, $3)
         RETURNING ${USER_COLUMNS}`,
        [email, passwordHash, role]
    );
    return rows[0];
};

export const updateUserRole = async (id, role) => {
    const { rows } = await pool.query(
        `UPDATE users SET role = $2 WHERE id = $1 RETURNING ${USER_COLUMNS}`,
        [id, role]
    );
    return rows[0] ?? null;
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
