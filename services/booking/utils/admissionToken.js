import jwt from "jsonwebtoken";
import { ADMISSION_TTL_SECONDS } from "../../../shared/queue.js";

const ADMISSION_TOKEN_SECRET = process.env.ADMISSION_TOKEN_SECRET;

// A third, separate credential from both the login JWT and the queue token.
// The queue token proves "I hold a place in line"; this one proves "the
// admitter let me *into* the booking flow." Booking Service is both issuer
// and verifier here — GET /queue/position issues it the moment the admitter's
// admitted-set shows this user cleared, and POST /bookings/reserve|confirm
// verify it before doing anything else.
//
// Its own TTL matches ADMISSION_TTL_SECONDS (shared/queue.js) rather than
// having an independent expiry — a token that outlived the Redis admission
// record it represents would let a caller pass the gate after the admitter
// has already reclaimed their slot for someone else; a token that expired
// before the record would reject a still-legitimately-admitted caller. Same
// window, same store, so the two can't drift apart in either direction.
export const signAdmissionToken = ({ userId, eventId }) =>
    jwt.sign({ eventId }, ADMISSION_TOKEN_SECRET, { subject: String(userId), expiresIn: ADMISSION_TTL_SECONDS });

// Throws on missing signature match, tampering, or expiry — the reserve/confirm
// gate treats any throw as "no valid admission," full stop. Verification here
// is pure signature/claims checking: no Redis call, no DB call, which is what
// makes "403 before any Redis or DB work" achievable on the reject path.
export const verifyAdmissionToken = (token) => {
    const payload = jwt.verify(token, ADMISSION_TOKEN_SECRET);
    return { userId: payload.sub, eventId: payload.eventId };
};
