import * as waitlistService from "../services/waitlist.service.js";
import * as cancelService from "../services/cancel.service.js";
import { responseHandler } from "../utils/response.js";
import { requireUserId } from "../validators/booking.validator.js";
import { validateEventIdParam, validateBookingIdParam } from "../validators/waitlist.validator.js";

export const joinWaitlist = async (req, res) => {
    const userId = requireUserId(req);
    const { eventId } = validateEventIdParam(req.params);

    const result = await waitlistService.join({ eventId, userId });
    return responseHandler(
        result,
        res,
        result.joined ? "Joined waitlist" : "Already on waitlist",
        result.joined ? 201 : 200
    );
};

export const getWaitlistStatus = async (req, res) => {
    const userId = requireUserId(req);
    const { eventId } = validateEventIdParam(req.params);
    const result = await waitlistService.getStatus({ eventId, userId });
    return responseHandler(result, res, "Waitlist status fetched", 200);
};

export const leaveWaitlist = async (req, res) => {
    const userId = requireUserId(req);
    const { eventId } = validateEventIdParam(req.params);
    const result = await waitlistService.leave({ eventId, userId });
    return responseHandler(result, res, "Left waitlist", 200);
};

export const cancelBooking = async (req, res) => {
    const userId = requireUserId(req);
    const { bookingId } = validateBookingIdParam(req.params);

    const result = await cancelService.cancelBooking({
        bookingId,
        userId,
        correlationId: req.correlationId,
    });
    return responseHandler(result, res, `Booking ${result.status}`, 200);
};
