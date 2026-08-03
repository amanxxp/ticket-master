import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

// Verification only — the gateway never signs an access token, only Auth
// Service does, using the same shared secret. Throws (JsonWebTokenError /
// TokenExpiredError) on missing signature match, tampering, or expiry; callers
// treat any throw here identically, since "missing/expired/tampered" are all
// the same 401 per REQUIREMENTS.md.
export const verifyAccessToken = (token) => {
    const payload = jwt.verify(token, JWT_SECRET);
    return { id: payload.sub, role: payload.role };
};

// "Bearer <token>" — anything else (missing header, wrong scheme, no token
// after the scheme) yields null rather than throwing, so an absent
// Authorization header can be distinguished from a present-but-invalid one by
// the caller without a try/catch just to check for a header's existence.
export const extractBearerToken = (authorizationHeader) => {
    if (typeof authorizationHeader !== "string") return null;
    const [scheme, token] = authorizationHeader.split(" ");
    if (scheme !== "Bearer" || !token) return null;
    return token;
};
