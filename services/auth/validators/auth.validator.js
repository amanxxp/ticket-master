import Joi from "joi";
import { ROLES } from "../../../shared/roles.js";

// `role` is deliberately absent from this schema — Joi strips unknown keys by
// default in this codebase's validate() convention, so a client sending
// `role: "admin"` at registration has it silently discarded, not honored.
// Self-registration must not be a privilege-escalation path.
export const registerSchema = Joi.object({
    email: Joi.string().trim().lowercase().email().max(320).required(),
    password: Joi.string().min(8).max(200).required(),
});

export const loginSchema = Joi.object({
    email: Joi.string().trim().lowercase().email().max(320).required(),
    password: Joi.string().min(1).max(200).required(),
});

export const refreshSchema = Joi.object({
    refreshToken: Joi.string().trim().min(1).max(512).required(),
});

export const logoutSchema = Joi.object({
    refreshToken: Joi.string().trim().min(1).max(512).required(),
});

// Only reachable through the admin-gated route (gateway policy: roles:
// ["admin"]) — `role` is accepted here on purpose, unlike registerSchema,
// since this IS the privileged path role assignment is supposed to go through.
export const adminCreateUserSchema = Joi.object({
    email: Joi.string().trim().lowercase().email().max(320).required(),
    password: Joi.string().min(8).max(200).required(),
    role: Joi.string().valid(...ROLES).required(),
});

export const updateRoleSchema = Joi.object({
    role: Joi.string().valid(...ROLES).required(),
});
