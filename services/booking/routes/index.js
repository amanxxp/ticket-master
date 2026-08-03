import { Router } from "express";
import bookingRoutes from "./booking.routes.js";
import queueRoutes from "./queue.routes.js";

const router = Router();

router.use("/bookings", bookingRoutes);
router.use("/queue", queueRoutes);

export default router;
