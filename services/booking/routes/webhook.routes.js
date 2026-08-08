import { Router } from "express";
import express from "express";
import { handleStripeWebhook } from "../controllers/webhook.controller.js";

const router = Router();

// express.raw, mounted on this route only, BEFORE the global express.json in
// app.js can touch the body. Signature verification runs against the exact bytes
// Stripe signed — a body that has been JSON.parsed and re-stringified will not
// verify, because key order and whitespace are both part of what was signed.
router.post(
    "/stripe",
    express.raw({ type: "application/json", limit: "1mb" }),
    handleStripeWebhook
);

export default router;
