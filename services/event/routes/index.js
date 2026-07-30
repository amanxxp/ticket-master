import { Router } from "express";
import eventRoutes from "./event.routes.js"
import venueRoutes from "./venue.routes.js"
const router = Router();

router.use('/events',eventRoutes);
router.use('/venues',venueRoutes);
export default router;
