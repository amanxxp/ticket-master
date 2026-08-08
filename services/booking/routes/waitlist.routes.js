import { Router } from "express";
import {
    joinWaitlist,
    getWaitlistStatus,
    leaveWaitlist,
} from "../controllers/waitlist.controller.js";

const router = Router();

// Mounted at /events by routes/index.js, so these are
// POST/GET/DELETE /events/:eventId/waitlist.
//
// Booking Service owns this path, not Event Service, even though it reads like an
// event resource: a waitlist entry is a claim on inventory, it is created by a
// cancellation, and it is consumed by a reservation — all three live here. Event
// Service owns event metadata and never writes claims. The gateway routes by
// prefix, so `/events/:id/waitlist` needs its own policy row pointing at booking.
router.post("/:eventId/waitlist", joinWaitlist);
router.get("/:eventId/waitlist", getWaitlistStatus);
router.delete("/:eventId/waitlist", leaveWaitlist);

export default router;
