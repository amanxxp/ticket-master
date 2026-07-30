import pool from "../config/db.js";

// Runs `fn` on a single dedicated client inside BEGIN/COMMIT. Every query that
// must be atomic with another has to go through the same client — using `pool`
// directly inside `fn` silently checks out a second connection and lands
// outside the transaction.
export const withTransaction = async (fn) => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (rollbackError) {
            // A failed rollback means the connection is unusable; log it but let
            // the original error surface, since that is the actual cause.
            console.error("Rollback failed", rollbackError);
        }
        throw error;
    } finally {
        client.release();
    }
};
