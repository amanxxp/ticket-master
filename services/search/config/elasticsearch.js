import { Client } from "@elastic/elasticsearch";
import { ensureSearchIndex as ensureIndex } from "../../../shared/searchIndex.js";

// The client constructor throws synchronously — not a rejected promise — if
// `node` is falsy. A missing env var must not crash the whole service at
// import time; that would contradict "boots with ES down" one step earlier
// than intended, so a same-default-as-.env.example fallback is required here,
// not optional.
const client = new Client({
    node: process.env.ELASTICSEARCH_URL || "http://localhost:9200",
    // Short — a search request should fail fast into the 503 path rather than
    // hang the client waiting on a datastore this service is explicitly allowed
    // to boot without.
    requestTimeout: 3000,
});

export const ensureSearchIndex = () => ensureIndex(client);

export default client;
