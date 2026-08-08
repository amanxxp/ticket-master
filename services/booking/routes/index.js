import { Router } from "express";
import bookingRoutes from "./booking.routes.js";
import queueRoutes from "./queue.routes.js";
import waitlistRoutes from "./waitlist.routes.js";

const router = Router();

router.use("/bookings", bookingRoutes);
router.use("/queue", queueRoutes);
router.use("/events", waitlistRoutes);

export default router;
