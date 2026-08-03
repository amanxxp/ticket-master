import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "node:crypto";

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "15m";
const REFRESH_TOKEN_EXPIRES_DAYS = Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS) || 30;

// `sub` + `role` is the whole contract the gateway relies on: it verifies the
// signature, trusts these two claims, and injects them downstream as
// X-User-Id/X-User-Role. No password hash, no email — nothing here is worth
// anything if the token leaks beyond identity + role for its own short life.
export const signAccessToken = ({ id, role }) =>
    jwt.sign({ role }, JWT_SECRET, { subject: String(id), expiresIn: JWT_EXPIRES_IN });

// Throws (JsonWebTokenError / TokenExpiredError) on a missing, tampered, or
// expired token — callers are expected to let that propagate to a 401, not
// interpret the specific error subtype themselves.
export const verifyAccessToken = (token) => {
    const payload = jwt.verify(token, JWT_SECRET);
    return { id: payload.sub, role: payload.role };
};

// Opaque — a random string, not a JWT. The refresh token's entire job is to be
// revocable, which a self-contained signed token structurally cannot be
// without a blacklist; storing it (hashed) in Postgres and checking `revoked_at`
// on every use is what makes logout actually work.
export const generateRefreshToken = () => {
    const token = randomBytes(32).toString("hex");
    return { token, tokenHash: hashRefreshToken(token), expiresAt: refreshExpiryDate() };
};

// sha256, not bcrypt — this value is 256 bits of crypto-random data, never
// typed or reused across sites the way a password is, so there is no
// low-entropy space an offline dictionary attack could search. A fast hash is
// the correct tool for "detect this exact value again cheaply," which is all
// this lookup needs.
export const hashRefreshToken = (token) => createHash("sha256").update(token).digest("hex");

export const refreshExpiryDate = () =>
    new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
