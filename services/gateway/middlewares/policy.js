import { MANAGER_ROLES, ADMIN_ROLES } from "../../../shared/roles.js";

// `:param` matches exactly one path segment (no slash) — this is what keeps
// `/events/:id` from ever matching `/events/:eventId/tickets` (three segments
// vs two), so route order below rarely has to fight ambiguity the way Express's
// own prefix-mounted middleware chaining does.
const pathToRegex = (pattern) => {
    const body = pattern
        .split("/")
        .map((segment) => {
            if (segment.startsWith(":")) return "[^/]+";
            return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/");
    return new RegExp(`^${body}$`);
};

// Rows taken verbatim from REQUIREMENTS.md's routing table (built Week 4) are
// marked SPEC; everything else is an inference by consistency with a sibling
// resource the table already covers, marked INFERRED. Venues and ticket
// management were never named in that table at all — they get the same
// public-read / organizer-write shape `/events` already has, since they are
// structurally the same kind of resource, not because the spec said so.
export const ROUTE_POLICIES = [
    // ---- pre-auth: the credential-exchange endpoints themselves ---- SPEC
    { method: "POST", path: "/auth/register", auth: "none" },
    { method: "POST", path: "/auth/login", auth: "none" },
    { method: "POST", path: "/auth/refresh", auth: "none" },
    { method: "POST", path: "/auth/logout", auth: "none" },

    // ---- admin-only user management ---- INFERRED (no such endpoint in the
    // original spec at all; added on request, gated the same way any other
    // privileged write is — auth required, role checked before proxying)
    { method: "POST", path: "/auth/admin/users", auth: "required", roles: ADMIN_ROLES },
    { method: "PUT", path: "/auth/admin/users/:id/role", auth: "required", roles: ADMIN_ROLES },

    // ---- explicit exemption: signature verification happens in Booking Service ---- SPEC
    { method: "POST", path: "/webhooks/stripe", auth: "none", rateLimited: false },

    // ---- public reads ---- SPEC
    // `/search` is public but ALSO rate-limited "keyed on the injected userId" —
    // those two requirements are in tension for an anonymous caller. Resolved
    // as "optional" auth: a valid token (if sent) is used for the userId key;
    // a request with none, or a bad one, is treated as anonymous and keyed on
    // IP instead. See DECISIONS.md.
    { method: "GET", path: "/search", auth: "optional", rateLimited: true, rateLimitGroup: "search" },
    { method: "GET", path: "/events", auth: "none" },
    { method: "GET", path: "/events/:id", auth: "none" },
    { method: "GET", path: "/events/:id/seatmap", auth: "none" },
    { method: "GET", path: "/events/:id/stream", auth: "none" },

    // ---- public reads ---- INFERRED (consistency with /events)
    { method: "GET", path: "/venues", auth: "none" },
    { method: "GET", path: "/venues/:id", auth: "none" },
    { method: "GET", path: "/events/:eventId/tickets", auth: "none" },
    { method: "GET", path: "/events/:eventId/tickets/:ticketId", auth: "none" },

    // ---- organizer-managed writes ---- SPEC
    { method: "POST", path: "/events", auth: "required", roles: MANAGER_ROLES },
    { method: "PUT", path: "/events/:id", auth: "required", roles: MANAGER_ROLES },
    { method: "DELETE", path: "/events/:id", auth: "required", roles: MANAGER_ROLES },

    // ---- organizer-managed writes ---- INFERRED (consistency with /events)
    { method: "POST", path: "/venues", auth: "required", roles: MANAGER_ROLES },
    { method: "PUT", path: "/venues/:id", auth: "required", roles: MANAGER_ROLES },
    { method: "DELETE", path: "/venues/:id", auth: "required", roles: MANAGER_ROLES },
    { method: "POST", path: "/events/:eventId/tickets", auth: "required", roles: MANAGER_ROLES },
    { method: "POST", path: "/events/:eventId/tickets/generate", auth: "required", roles: MANAGER_ROLES },
    { method: "PUT", path: "/events/:eventId/tickets/:ticketId", auth: "required", roles: MANAGER_ROLES },
    { method: "DELETE", path: "/events/:eventId/tickets/:ticketId", auth: "required", roles: MANAGER_ROLES },

    // ---- authenticated user actions, any role ---- SPEC
    { method: "POST", path: "/events/:id/waitlist", auth: "required" },
    { method: "POST", path: "/queue/join", auth: "required", rateLimited: true, rateLimitGroup: "booking" },
    { method: "GET", path: "/queue/position", auth: "required" },
    { method: "POST", path: "/bookings/reserve", auth: "required", rateLimited: true, rateLimitGroup: "booking" },
    { method: "POST", path: "/bookings/confirm", auth: "required", rateLimited: true, rateLimitGroup: "booking" },
    { method: "POST", path: "/bookings/:id/cancel", auth: "required" },

    // ---- authenticated user actions, any role ---- INFERRED (the user's own hold/booking)
    { method: "DELETE", path: "/bookings/reserve/:id", auth: "required" },
    { method: "GET", path: "/bookings/holds/:eventId", auth: "required" },
    { method: "GET", path: "/bookings/:id", auth: "required" },
];

// Deny-by-default for anything not explicitly listed above — a route this
// policy table forgot to name should require a valid identity, not silently
// allow anonymous access.
const DEFAULT_POLICY = { auth: "required", roles: null, rateLimited: false };

export const matchPolicy = (method, path) => {
    for (const policy of ROUTE_POLICIES) {
        if (policy.method === method && pathToRegex(policy.path).test(path)) {
            return policy;
        }
    }
    return DEFAULT_POLICY;
};
