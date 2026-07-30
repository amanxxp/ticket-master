// Outbox rows are written on the same client as the change that produced them,
// so the event and its published record commit or roll back together. Per
// REQUIREMENTS.md the poller reads unpublished rows and ships them to Elasticsearch.
export const insertOutboxEvent = async (client, { aggregateType, aggregateId, payload }) => {
    const { rows } = await client.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, payload)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [aggregateType, aggregateId, payload]
    );
    return rows[0];
};
