import * as bookingService from "../services/booking.service.js";
import { responseHandler } from "../utils/response.js";
import { requireUserId, validateConfirmBooking } from "../validators/booking.validator.js";
import { requireAdmission } from "../middlewares/requireAdmission.js";
import { createApiError } from "../utils/apiError.js";

export const confirmBooking = async (req, res) => {
    const userId = requireUserId(req);
    const { eventId, ticketIds } = validateConfirmBooking(req.body);
    // Admission is required on confirm too, not just reserve — per the
    // routing table, both are gated the same way. A reserved hold does not
    // itself carry admission forward; the admission token must still be
    // presented (and still be unexpired) on the confirm call too.
    requireAdmission(req, userId, eventId);

    const booking = await bookingService.confirmBooking({ userId, eventId, ticketIds, correlationId: req.correlationId });
    return responseHandler(booking, res, "Booking confirmed", 201);
}

export const getBooking = async (req, res) => {
    const userId = requireUserId(req);
    const { id } = req.params;
    if (!/^\d+$/.test(id)) {
        throw createApiError("id must be a positive integer", 422);
    }
    const booking = await bookingService.getBooking(id, userId);
    return responseHandler(booking, res, "Booking fetched", 200);
}
