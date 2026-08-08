import { Router } from "express";
import { createUpstreamProxy, streamPathFilter, waitlistPathFilter, prefixFilter } from "./proxy.js";
import { authenticate } from "../middlewares/authenticate.js";
import { enforceAccess } from "../middlewares/enforceAccess.js";

const router = Router();

const AUTH_URL = process.env.AUTH_URL || "http://localhost:3001";
const EVENT_URL = process.env.EVENT_URL || "http://localhost:3002";
const SEARCH_URL = process.env.SEARCH_URL || "http://localhost:3003";
const BOOKING_URL = process.env.BOOKING_URL || "http://localhost:3004";

// authenticate only ever populates req.user/req.authError, never rejects;
// enforceAccess is what turns the per-route policy (middlewares/policy.js)
// into an actual 401/403/429, or lets the request through to be proxied. Both
// run before every proxy below, including the ones that turn out to be public —
// a public route still needs req.user populated when a token happens to be
// present (search's rate limiter keys on it when available).
router.use(authenticate);
router.use(enforceAccess);

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

// Same reasoning, same fix, one path over: `/events/:id/waitlist` is a Booking
// Service route (policy.js already names it `auth: "required"` under that
// exact path), but it lives one path segment inside the `/events` prefix
// Event Service claims below. Registered here — before that general proxy —
// so it is actually reachable rather than 404ing at Event Service, which has
// no such route and never will.
router.use(createUpstreamProxy({ name: "booking", target: BOOKING_URL, pathFilter: waitlistPathFilter }));

router.use(createUpstreamProxy({ name: "auth", target: AUTH_URL, pathFilter: prefixFilter("/auth") }));
router.use(createUpstreamProxy({ name: "event", target: EVENT_URL, pathFilter: prefixFilter("/events") }));
// Venues live in Event Service too, under their own prefix — never actually
// wired at all in Day 1, despite being reachable and (per policy.js) governed
// by the same auth/role rules as /events.
router.use(createUpstreamProxy({ name: "event", target: EVENT_URL, pathFilter: prefixFilter("/venues") }));
router.use(createUpstreamProxy({ name: "search", target: SEARCH_URL, pathFilter: prefixFilter("/search") }));
router.use(createUpstreamProxy({ name: "booking", target: BOOKING_URL, pathFilter: prefixFilter("/bookings") }));
// The queue/waiting-room endpoints are Booking Service's per the routing
// table, and (like /webhooks) have no handler built yet — Week 5 territory.
// Wired now so policy.js's auth+rate-limit rules for /queue/* are real routes,
// not rules for paths that 404 before ever reaching a policy check.
router.use(createUpstreamProxy({ name: "booking", target: BOOKING_URL, pathFilter: prefixFilter("/queue") }));
// No handler exists yet on Booking Service's side (Stripe integration is
// Week 5) — wired now so the auth/rate-limit EXEMPTION itself is real and
// testable ahead of the handler landing; today it 404s from Booking Service,
// correctly reflecting that the endpoint doesn't exist yet.
router.use(createUpstreamProxy({ name: "booking", target: BOOKING_URL, pathFilter: prefixFilter("/webhooks") }));

export default router;
