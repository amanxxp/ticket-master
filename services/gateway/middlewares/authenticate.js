import { extractBearerToken, verifyAccessToken } from "../utils/jwt.js";

// Deliberately never rejects on its own — "required" vs "public" vs "optional"
// is a per-route policy decision (middlewares/policy.js), not something this
// middleware can know. It only ever does one thing: if a Bearer token is
// present, try to verify it and record the outcome on `req`. A missing header
// is not an error (req.user stays undefined); a present-but-invalid token
// records `req.authError` so a route that actually requires auth can
// distinguish "no attempt was made" from "an attempt failed."
export const authenticate = (req, res, next) => {
    const token = extractBearerToken(req.get("Authorization"));
    if (!token) {
        return next();
    }

    try {
        req.user = verifyAccessToken(token);
    } catch (err) {
        req.authError = err;
    }
    next();
};
