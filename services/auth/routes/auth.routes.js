import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import {
    registerSchema,
    loginSchema,
    refreshSchema,
    logoutSchema,
    adminCreateUserSchema,
    updateRoleSchema,
} from "../validators/auth.validator.js";
import {
    register,
    login,
    refresh,
    logout,
    adminCreateUser,
    updateUserRole,
} from "../controllers/auth.controller.js";

const router = Router();

router.post("/register", validate(registerSchema), register);
router.post("/login", validate(loginSchema), login);
router.post("/refresh", validate(refreshSchema), refresh);
router.post("/logout", validate(logoutSchema), logout);

// Both admin-only — enforced at the gateway (policy.js: roles: ["admin"]),
// not re-checked here. Reachable directly (bypassing the gateway) only if the
// network trust boundary in DECISIONS.md #47 is broken, in which case a lot
// more than this is already compromised.
router.post("/admin/users", validate(adminCreateUserSchema), adminCreateUser);
router.put("/admin/users/:id/role", validate(updateRoleSchema), updateUserRole);

export default router;
