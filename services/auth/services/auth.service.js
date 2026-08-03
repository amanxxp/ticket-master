import { createApiError } from "../utils/apiError.js";
import { hashPassword, verifyPassword, verifyAgainstDummyHash } from "../utils/password.js";
import { signAccessToken, generateRefreshToken, hashRefreshToken } from "../utils/tokens.js";
import { insertUser, getUserByEmail, getUserById } from "../repositories/user.repository.js";
import { insertRefreshToken, getActiveRefreshToken, revokeRefreshToken } from "../repositories/refreshToken.repository.js";

const UNIQUE_VIOLATION = "23505";

// Registration only creates the account — it does not also log the caller in.
// REQUIREMENTS.md's acceptance criteria only specify login's token behavior;
// keeping register minimal avoids inventing a second, untested contract for
// what it returns.
export const register = async ({ email, password }) => {
    const passwordHash = await hashPassword(password);
    try {
        return await insertUser({ email, passwordHash });
    } catch (error) {
        if (error.code === UNIQUE_VIOLATION) {
            throw createApiError(`Email ${email} is already registered`, 409);
        }
        throw error;
    }
};

// Same error, same message, whichever step failed — and the dummy-hash compare
// runs on every "no such user" path specifically so the two failure reasons
// take the same amount of time. A different message or an early return before
// the dummy compare would both leak which one happened, from timing or text.
const INVALID_CREDENTIALS = "Invalid email or password";

export const login = async ({ email, password }) => {
    const user = await getUserByEmail(email);

    if (!user) {
        await verifyAgainstDummyHash(password);
        throw createApiError(INVALID_CREDENTIALS, 401);
    }

    const passwordMatches = await verifyPassword(password, user.passwordHash);
    if (!passwordMatches) {
        throw createApiError(INVALID_CREDENTIALS, 401);
    }

    const accessToken = signAccessToken({ id: user.id, role: user.role });
    const { token: refreshToken, tokenHash, expiresAt } = generateRefreshToken();
    await insertRefreshToken({ userId: user.id, tokenHash, expiresAt });

    return { accessToken, refreshToken, role: user.role };
};

// Looks the user up fresh rather than trusting anything cached from login —
// a promotion/demotion between login and refresh must show up in the new
// access token; refresh is exactly the moment that's possible without forcing
// a new login, since a JWT itself is a stale snapshot for its whole lifetime
// otherwise.
export const refresh = async ({ refreshToken }) => {
    const tokenHash = hashRefreshToken(refreshToken);
    const active = await getActiveRefreshToken(tokenHash);
    if (!active) {
        throw createApiError("Refresh token is invalid, expired, or revoked", 401);
    }

    const user = await getUserById(active.userId);
    if (!user) {
        throw createApiError("Refresh token is invalid, expired, or revoked", 401);
    }

    return { accessToken: signAccessToken({ id: user.id, role: user.role }) };
};

// Quiet and idempotent: logging out an already-logged-out (or never-valid)
// token is not a security event worth a different response for — revoking a
// row that doesn't match just updates zero rows.
export const logout = async ({ refreshToken }) => {
    await revokeRefreshToken(hashRefreshToken(refreshToken));
};
