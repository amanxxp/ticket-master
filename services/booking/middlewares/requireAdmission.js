import { createApiError } from "../utils/apiError.js";
import { verifyAdmissionToken } from "../utils/admissionToken.js";

// Called inline from the controller, after requireUserId/validate* — same
// convention those already use (plain functions the controller calls, not an
// Express middleware chain). Verifying a JWT is pure signature/claims
// checking, no store access, so a missing or invalid admission token rejects
// with genuinely zero Redis/DB calls: everything before this point in the
// controller (reading a header, running a Joi-style regex check) touches
// nothing external either.
//
// 403, not 401: the caller already has a valid *login* identity
// (requireUserId already succeeded) — this is "authenticated but not
// admitted," the same authenticated-but-unauthorized shape as a wrong-role
// write elsewhere in this system, not a missing/bad identity.
export const requireAdmission = (req, userId, eventId) => {
    const token = req.get("x-admission-token");
    if (!token) {
        throw createApiError("Admission required before booking", 403);
    }

    let claims;
    try {
        claims = verifyAdmissionToken(token);
    } catch {
        throw createApiError("Invalid or expired admission", 403);
    }

    if (claims.userId !== userId || String(claims.eventId) !== String(eventId)) {
        throw createApiError("Admission does not match this user/event", 403);
    }
};
