import { SEARCH_INDEX, searchDocId, toSearchDocument } from "../../../shared/searchIndex.js";

// The outbox table is shared by every aggregate type any service chooses to
// write to it (event, ticket, booking, ...) — this poller only cares about the
// subset that changes what's searchable. Everything else (ticket updates,
// booking confirms, the "tickets.created" event-aggregate row ticket minting
// emits) is search-irrelevant and falls through to the default branch: no ES
// call, but still marked published, so an irrelevant row doesn't get reclaimed
// by SKIP LOCKED forever. This is deliberately a whitelist of what to ACT on,
// not a blacklist of what to ignore — a new aggregate type or payload shape
// added anywhere else in the system is inert here by default, never a crash.
export const applyToElasticsearch = async (esClient, row) => {
    if (row.aggregateType !== "event") return;

    const { type, event } = row.payload;

    switch (type) {
        case "event.created":
        case "event.updated":
            await esClient.index({
                index: SEARCH_INDEX,
                id: searchDocId(event.id),
                document: toSearchDocument(event),
            });
            return;

        case "event.deleted":
            // Deleted outright rather than flagged — "removed from search
            // results" is then true of every query with no filter to remember,
            // and there's nothing else the search index needs the row for.
            try {
                await esClient.delete({ index: SEARCH_INDEX, id: searchDocId(event.id) });
            } catch (err) {
                // Already gone (e.g. a retried delete after a crash) is success,
                // not a failure to retry indefinitely.
                if (err.meta?.statusCode !== 404) throw err;
            }
            return;

        default:
            return;
    }
};
