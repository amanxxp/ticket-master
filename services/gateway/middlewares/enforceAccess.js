import { matchPolicy } from "./policy.js";
import { createApiError } from "../utils/apiError.js";
import { enforceRateLimit } from "./rateLimit.js";

// Runs after `authenticate` (which only ever populates req.user/req.authError,
// never rejects) and before the upstream proxies. This is the one place that
// turns "what does the policy for this route say" into an actual 401/403/429,
// or lets the request through to be proxied.
export const enforceAccess = async (req, res, next) => {
    try {
        const policy = matchPolicy(req.method, req.path);
        req.routePolicy = policy;

        if (policy.auth === "required" && !req.user) {
            // Distinguishes "no attempt was made" from "a token was sent and
            // failed" only in the log/message, not the status — both are 401
            // per REQUIREMENTS.md ("missing/expired/tampered ... 401").
            throw createApiError(
                req.authError ? "Invalid or expired token" : "Authentication required",
                401
            );
        }
        // 'optional' and 'none' proceed regardless of req.user/req.authError —
        // a bad token on a public/optional route means anonymous, not a 401.

        if (policy.roles) {
            // Reachable with req.user unset only if a future policy entry sets
            // `roles` without `auth: 'required'` — the check above already 401'd
            // otherwise. Kept as a real check, not assumed away, since a role
            // list with no identity to test it against would otherwise silently
            // permit everyone.
            if (!req.user || !policy.roles.includes(req.user.role)) {
                throw createApiError(
                    `Role '${req.user?.role ?? "none"}' is not permitted for this action`,
                    403
                );
            }
        }

        if (policy.rateLimited && policy.rateLimitGroup) {
            const identityKey = req.user ? `user:${req.user.id}` : `ip:${req.ip}`;
            await enforceRateLimit(req, policy.rateLimitGroup, identityKey);
        }

        next();
    } catch (err) {
        next(err);
    }
};
