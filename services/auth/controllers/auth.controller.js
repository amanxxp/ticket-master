import * as authService from "../services/auth.service.js";
import { responseHandler } from "../utils/response.js";

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
