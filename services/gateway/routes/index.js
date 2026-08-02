import { Router } from "express";
import { createUpstreamProxy, streamPathFilter, prefixFilter } from "./proxy.js";

const router = Router();

const AUTH_URL = process.env.AUTH_URL || "http://localhost:3001";
const EVENT_URL = process.env.EVENT_URL || "http://localhost:3002";
const SEARCH_URL = process.env.SEARCH_URL || "http://localhost:3003";
const BOOKING_URL = process.env.BOOKING_URL || "http://localhost:3004";

// Registered before the general '/events' proxy below — Express walks
// middleware in registration order, and a stream request must be claimed by
// this narrower, no-timeout proxy before the broader '/events' one (with a
// finite timeout meant for ordinary REST calls) ever gets a look at it. Same
// "more specific route wins by going first" rule Event Service itself uses
// for /events/:eventId/tickets vs /events/:id.
router.use(createUpstreamProxy({
    name: "event",
    target: EVENT_URL,
    pathFilter: streamPathFilter,
    proxyTimeoutMs: 0,
}));

router.use(createUpstreamProxy({ name: "auth", target: AUTH_URL, pathFilter: prefixFilter("/auth") }));
router.use(createUpstreamProxy({ name: "event", target: EVENT_URL, pathFilter: prefixFilter("/events") }));
router.use(createUpstreamProxy({ name: "search", target: SEARCH_URL, pathFilter: prefixFilter("/search") }));
router.use(createUpstreamProxy({ name: "booking", target: BOOKING_URL, pathFilter: prefixFilter("/bookings") }));

export default router;
