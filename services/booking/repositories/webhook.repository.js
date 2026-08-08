export const WEBHOOK_ALREADY_SEEN = "23505";

// Insert-only. There is no update path and no "mark processed later" column: the
// row's existence IS the record that this delivery was handled, and it is written
// in the same transaction as the state change it authorises. A two-phase
// "insert then mark done" would reopen exactly the replay window the UNIQUE
// constraint exists to close.
export const recordWebhookEvent = async (client, { provider, eventId, type }) => {
    const { rows } = await client.query(
        `INSERT INTO webhook_events (provider, event_id, type)
         VALUES ($1, $2, $3)
         RETURNING id, processed_at AS "processedAt"`,
        [provider, eventId, type]
    );
    return rows[0];
};

export const countWebhookEvents = async (client, provider, eventId) => {
    const { rows } = await client.query(
        `SELECT count(*)::int c FROM webhook_events WHERE provider = $1 AND event_id = $2`,
        [provider, eventId]
    );
    return rows[0].c;
};
