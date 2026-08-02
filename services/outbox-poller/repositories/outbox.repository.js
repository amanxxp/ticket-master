// SKIP LOCKED is the competing-consumers mechanism: two poller instances
// running the same query at the same time each lock a disjoint set of rows —
// whichever rows instance A already has FOR UPDATE, instance B's SKIP LOCKED
// simply excludes from its result set and moves on, rather than blocking behind
// A's lock. Neither instance ever waits on the other, and no row is ever
// claimed by both — "no double-publish, no row processed twice" without any
// coordination between the two processes beyond the database itself.
export const claimBatch = async (client, limit) => {
    const { rows } = await client.query(
        `SELECT id, aggregate_type AS "aggregateType", aggregate_id AS "aggregateId", payload
         FROM outbox
         WHERE published_at IS NULL
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit]
    );
    return rows;
};

export const markPublished = async (client, id) => {
    await client.query(
        `UPDATE outbox SET published_at = now() WHERE id = $1`,
        [id]
    );
};
