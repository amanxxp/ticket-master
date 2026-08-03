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
