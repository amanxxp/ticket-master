import Router from "express";
import { validate } from "../middlewares/validate.js";
import {
    createVenueSchema,
    updateVenueSchema,
    venueIdParamSchema,
    listVenuesQuerySchema,
} from "../validators/venue.validator.js";
import {
    createVenue,
    getAllVenues,
    getVenueById,
    updateVenue,
    deleteVenue,
} from "../controllers/venue.controller.js"

const router = Router();

router.route('/')
    .post(validate(createVenueSchema), createVenue)
    .get(validate(listVenuesQuerySchema, "query"), getAllVenues);

router.route('/:id')
    .get(validate(venueIdParamSchema, "params"), getVenueById)
    .put(validate(venueIdParamSchema, "params"), validate(updateVenueSchema), updateVenue)
    .delete(validate(venueIdParamSchema, "params"), deleteVenue);

export default router;
