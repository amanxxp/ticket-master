import { createApiError } from "../utils/apiError.js";
import { SEARCH_INDEX } from "../../../shared/searchIndex.js";
import esClient from "../config/elasticsearch.js";

// term="" must return results, not crash — an empty string is treated as "no
// term filter" (a bare browse), not sent to ES as a query it would have to
// special-case.
const termClause = (term) => {
    if (!term) return null;
    return {
        bool: {
            should: [
                // Typo tolerance: edit-distance matching on the analyzed base
                // fields. `AUTO` scales the allowed distance with term length,
                // so a 1-character typo on "Concert" still matches without also
                // matching short unrelated words.
                {
                    multi_match: {
                        query: term,
                        fields: ["name^3", "description", "venueName^2", "performerName^2"],
                        fuzziness: "AUTO",
                    },
                },
                // Partial/prefix matching: "conc" is a real indexed term on the
                // edge-ngram `.autocomplete` subfields (see shared/searchIndex.js),
                // so this needs no fuzziness — the prefix is already there.
                {
                    multi_match: {
                        query: term,
                        fields: ["name.autocomplete^3", "venueName.autocomplete^2", "performerName.autocomplete^2"],
                    },
                },
            ],
            minimum_should_match: 1,
        },
    };
};

const locationClause = (location) =>
    location ? { match: { venueLocation: location } } : null;

// A single calendar day, [00:00, next day 00:00) — "date range" per the
// acceptance criterion, expressed from one `date=YYYY-MM-DD` query param rather
// than a pair of range-endpoint params, matching the single-param route the
// spec names.
const dateClause = (date) => {
    if (!date) return null;
    const start = `${date}T00:00:00.000Z`;
    const end = new Date(new Date(start).getTime() + 24 * 60 * 60 * 1000).toISOString();
    return { range: { eventDate: { gte: start, lt: end } } };
};

const buildQuery = ({ term, location, date }) => {
    const clauses = [termClause(term), locationClause(location), dateClause(date)].filter(Boolean);
    if (clauses.length === 0) {
        return { match_all: {} };
    }
    return { bool: { must: clauses } };
};

// ES connection errors surface as 503, not 500 — the requirement this service
// was built to is "boot with ES down, degrade, recover on its own," and a
// search request hitting a down ES is exactly that degraded state, not an
// application bug.
const isConnectionError = (err) =>
    err.name === "ConnectionError" || err.name === "TimeoutError" || err.name === "NoLivingConnectionsError";

// The index not existing yet is the same "not ready" state as ES being down —
// it means ensureSearchIndex hasn't run successfully (yet), not that the query
// itself was wrong.
const isMissingIndex = (err) => err.meta?.body?.error?.type === "index_not_found_exception";

// Returns Partial<Event>[] — id/name/venue/performer/date, not the full event
// row. The client fetches full detail from Event Service; this exists to find
// candidates, not to be the system of record for event data.
const toPartialEvent = (hit) => ({
    id: hit._source.id,
    name: hit._source.name,
    description: hit._source.description,
    venueId: hit._source.venueId,
    venueName: hit._source.venueName,
    venueLocation: hit._source.venueLocation,
    performerId: hit._source.performerId,
    performerName: hit._source.performerName,
    eventDate: hit._source.eventDate,
});

export const searchEvents = async ({ term, location, date, size }) => {
    let response;
    try {
        response = await esClient.search({
            index: SEARCH_INDEX,
            size,
            query: buildQuery({ term, location, date }),
        });
    } catch (err) {
        if (isConnectionError(err) || isMissingIndex(err)) {
            throw createApiError("Search is temporarily unavailable", 503);
        }
        throw err;
    }

    // No match -> 200 + [] falls out naturally: hits.hits is just empty, no
    // special case needed, same pattern GET /events uses for an empty page.
    return response.hits.hits.map(toPartialEvent);
};
