import { Router } from "express";
import { confirmBooking, getBooking } from "../controllers/booking.controller.js";
import { reserveTickets, releaseTickets, listHolds } from "../controllers/hold.controller.js";
import { cancelBooking } from "../controllers/waitlist.controller.js";

const router = Router();

// Declared before `/:id` — Express matches in order, so `GET /bookings/holds/1`
// would otherwise be swallowed by the booking-id route.
router.post('/reserve', reserveTickets);
router.delete('/reserve/:id', releaseTickets);
router.get('/holds/:eventId', listHolds);

router.post('/confirm', confirmBooking);
router.post('/:id/cancel', cancelBooking);
router.get('/:id', getBooking);

export default router;
