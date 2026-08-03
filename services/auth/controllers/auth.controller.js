import * as authService from "../services/auth.service.js";
import { responseHandler } from "../utils/response.js";
import { createApiError } from "../utils/apiError.js";

export const register = async (req, res) => {
    const { email, password } = req.body;
    const user = await authService.register({ email, password });
    return responseHandler(user, res, "Registered successfully", 201);
}

export const login = async (req, res) => {
    const { email, password } = req.body;
    const tokens = await authService.login({ email, password });
    return responseHandler(tokens, res, "Login successful", 200);
}

export const refresh = async (req, res) => {
    const { refreshToken } = req.body;
    const tokens = await authService.refresh({ refreshToken });
    return responseHandler(tokens, res, "Token refreshed", 200);
}

export const logout = async (req, res) => {
    const { refreshToken } = req.body;
    await authService.logout({ refreshToken });
    return responseHandler(null, res, "Logged out", 200);
}

// Gateway-gated to roles:["admin"] (policy.js) — this handler trusts that and
// does not re-check X-User-Role itself; it is not wired to any other route.
export const adminCreateUser = async (req, res) => {
    const { email, password, role } = req.body;
    const user = await authService.adminCreateUser({ email, password, role });
    return responseHandler(user, res, "User created", 201);
}

export const updateUserRole = async (req, res) => {
    const { id } = req.params;
    if (!/^\d+$/.test(id)) {
        throw createApiError("id must be a positive integer", 422);
    }
    const { role } = req.body;
    const user = await authService.changeUserRole({ id, role });
    return responseHandler(user, res, "Role updated", 200);
}
