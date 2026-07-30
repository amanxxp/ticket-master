import Router from "express";
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

const router = Router();

router.route('/')
    .post(validate(createEventSchema), createEvent)
    .get(validate(listEventsQuerySchema, "query"), getEvents);

router.route('/:id')
    .get(validate(eventIdParamSchema, "params"), getEventById)
    .put(validate(eventIdParamSchema, "params"), validate(updateEventSchema), updateEvent)
    .delete(validate(eventIdParamSchema, "params"), deleteEvent);

export default router;
