import bcrypt from "bcrypt";

// A cost factor, not a fast hash — bcrypt is deliberately slow, and the cost
// controls exactly how slow. Configurable so a test suite can drop it without
// weakening the real deployment's value.
const BCRYPT_COST = Number(process.env.BCRYPT_COST) || 12;

// Precomputed once at module load (not lazily on first login) — every login
// call, real or against a nonexistent email, must run the exact same bcrypt
// compare cost every time, or the boot-time compute for this hash would itself
// be a one-time timing tell on the very first request.
const DUMMY_HASH = bcrypt.hashSync("no-such-account-placeholder-value", BCRYPT_COST);

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_COST);

export const verifyPassword = (password, hash) => bcrypt.compare(password, hash);

// Called when the email lookup found no user. Runs the identical KDF work a
// real comparison would against the account's actual hash — bcrypt's cost is
// what dominates response time, so a client measuring login latency cannot
// distinguish "wrong password" from "no such account" from timing alone.
// Always resolves false; the caller still has to reject the login either way.
export const verifyAgainstDummyHash = (password) => bcrypt.compare(password, DUMMY_HASH);
