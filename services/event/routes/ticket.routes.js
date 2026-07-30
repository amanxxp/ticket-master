// Named import: `import Router from "express"` is the express() app factory, and
// calling it builds a sub-app that silently drops Router options like mergeParams.
import { Router } from "express";
import { validate } from "../middlewares/validate.js";
import {
    createTicketsSchema,
    generateTicketsSchema,
    updateTicketSchema,
    ticketIdParamSchema,
    eventIdParamSchema,
    listTicketsQuerySchema,
} from "../validators/ticket.validator.js";
import {
    createTickets,
    generateTickets,
    getTickets,
    getTicketById,
    updateTicket,
    deleteTicket,
} from "../controllers/ticket.controller.js";

// mergeParams: tickets are always addressed through their event, so :eventId is
// owned by the parent router and has to be inherited here.
const router = Router({ mergeParams: true });

router.route('/')
    .post(validate(eventIdParamSchema, "params"), validate(createTicketsSchema), createTickets)
    .get(validate(eventIdParamSchema, "params"), validate(listTicketsQuerySchema, "query"), getTickets);

// Separate path, not POST / with a mode flag: minting from the seat map and
// inserting an explicit list have different bodies and different failure modes.
router.route('/generate')
    .post(validate(eventIdParamSchema, "params"), validate(generateTicketsSchema), generateTickets);

router.route('/:ticketId')
    .get(validate(ticketIdParamSchema, "params"), getTicketById)
    .put(validate(ticketIdParamSchema, "params"), validate(updateTicketSchema), updateTicket)
    .delete(validate(ticketIdParamSchema, "params"), deleteTicket);

export default router;
