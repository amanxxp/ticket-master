import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import {
    createEventSchema,
    updateEventSchema,
    eventIdParamSchema,
    listEventsQuerySchema,
} from "../validators/event.validator.js";
import {
    createEvent,
    getEvents,
    getEventById,
    updateEvent,
    deleteEvent,
} from "../controllers/event.controller.js";
import { getSeatMap } from "../controllers/seatmap.controller.js";
import ticketRoutes from "./ticket.routes.js";

const router = Router();

// Mounted before '/:id' so the more specific path wins.
router.use('/:eventId/tickets', ticketRoutes);

router.route('/')
    .post(validate(createEventSchema), createEvent)
    .get(validate(listEventsQuerySchema, "query"), getEvents);

router.get('/:id/seatmap', validate(eventIdParamSchema, "params"), getSeatMap);

router.route('/:id')
    .get(validate(eventIdParamSchema, "params"), getEventById)
    .put(validate(eventIdParamSchema, "params"), validate(updateEventSchema), updateEvent)
    .delete(validate(eventIdParamSchema, "params"), deleteEvent);

export default router;
