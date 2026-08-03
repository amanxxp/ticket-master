import Joi from "joi";

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
