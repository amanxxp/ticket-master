import { Client } from "@elastic/elasticsearch";
import { ensureSearchIndex as ensureIndex } from "../../../shared/searchIndex.js";

// Same fallback-default reasoning as Search Service's client: a missing env var
// must not crash construction, since a crashed poller means the outbox backs up
// silently until someone notices — worse than one call failing at request time.
const client = new Client({
    node: process.env.ELASTICSEARCH_URL || "http://localhost:9200",
    requestTimeout: 5000,
});

export const ensureSearchIndex = () => ensureIndex(client);

export default client;
