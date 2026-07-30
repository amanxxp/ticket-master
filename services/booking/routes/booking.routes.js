import { Router } from "express";
import { confirmBooking, getBooking } from "../controllers/booking.controller.js";

const router = Router();

router.post('/confirm', confirmBooking);
router.get('/:id', getBooking);

export default router;
