// Redis key naming shared between Booking Service (owns the waiting queue —
// join/position) and the Admitter worker (the only writer of admission and
// sold-out state, the only reader that ever pops the waiting queue). Same
// drift risk as shared/availability.js's hold keys: two processes referring
// to "the same queue" must agree on identical key strings without either one
// guessing at the other's convention.

export const ADMISSION_TTL_SECONDS = Number(process.env.ADMISSION_TTL_SECONDS) || 900;

const tag = (eventId) => `queue:{evt:${eventId}}`;

export const queueKey = (eventId) => tag(eventId);
export const queueSeqKey = (eventId) => `${tag(eventId)}:seq`;
export const departuresKey = (eventId) => `${tag(eventId)}:departures`;

// ZSET, member=userId, score=admission expiry (ms) — same "score carries
// expiry, not a per-key TTL" pattern as the hold ZSETs, for the same reason:
// bulk membership ("is anyone's admission still live") has to stay an O(1)
// round trip, and an expired admission must never be observable as live just
// because nothing has swept it yet.
export const admittedKey = (eventId) => `${tag(eventId)}:admitted`;

// A plain flag, not a per-user set — once an event is sold out, every
// remaining queue member gets the same answer, so there is nothing per-user
// to track.
export const soldOutKey = (eventId) => `${tag(eventId)}:soldout`;

// Global registry (not per-event) of events with a non-empty waiting queue —
// lets the admitter discover which events need attention with one SMEMBERS
// call instead of a KEYS/SCAN over the whole keyspace, which is unsafe to run
// against a live instance and not O(1) either.
export const ACTIVE_QUEUES_KEY = "queue:active-events";
