// Must match db/schema.sql's `users.role` CHECK constraint exactly — the
// gateway's authz policy and the database's own constraint are two
// independent guards on the same set of values, and they can't drift.
export const ROLES = ["user", "organizer", "admin"];

// Roles allowed to manage events/venues/tickets (create/update/delete). Not
// named in REQUIREMENTS.md's routing table explicitly — inferred from the
// domain model, where events/venues are organizer-owned resources. Shared so
// the gateway's route policy has one definition of "who can write inventory,"
// not a list re-typed at every route entry.
export const MANAGER_ROLES = ["organizer", "admin"];

// Roles allowed to create a user with an arbitrary role, or change an
// existing user's role. A one-element array, not a bare string, so
// policy.js's `roles.includes(...)` check works identically for every
// roles-gated route regardless of how many roles it allows.
export const ADMIN_ROLES = ["admin"];
