import jwt from "jsonwebtoken";

const QUEUE_TOKEN_SECRET = process.env.QUEUE_TOKEN_SECRET;
const QUEUE_TOKEN_TTL_SECONDS = Number(process.env.QUEUE_TOKEN_TTL_SECONDS) || 3600;

// A separate secret from Auth Service's JWT_SECRET, and a separate concern
// entirely from login: this token doesn't assert "who you are" (the gateway's
// injected X-User-Id already does that) — it asserts "you hold a specific
// slot in this specific event's queue." Binding both userId and eventId into
// the signature is what makes token theft detectable: a copied token used by
// a different logged-in user, or replayed against a different event's queue,
// fails the bound-identity check in queue.service.js even though the
// signature itself still verifies fine.
export const signQueueToken = ({ userId, eventId }) =>
    jwt.sign({ eventId }, QUEUE_TOKEN_SECRET, { subject: String(userId), expiresIn: QUEUE_TOKEN_TTL_SECONDS });

// Throws on missing signature match, tampering, or expiry — callers treat any
// throw as "this token proves nothing," same convention as every other JWT
// verification in this system.
export const verifyQueueToken = (token) => {
    const payload = jwt.verify(token, QUEUE_TOKEN_SECRET);
    return { userId: payload.sub, eventId: payload.eventId };
};
