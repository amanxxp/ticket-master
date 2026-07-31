import * as holdService from "../services/hold.service.js";
import { responseHandler } from "../utils/response.js";
import { requireUserId, validateReserve } from "../validators/booking.validator.js";
import { decodeHoldId } from "../utils/holdId.js";
import { getLiveHolds } from "../repositories/hold.repository.js";
import { createApiError } from "../utils/apiError.js";

export const reserveTickets = async (req, res) => {
    const userId = requireUserId(req);
    const { eventId, ticketIds } = validateReserve(req.body);

    const hold = await holdService.reserve({ userId, eventId, ticketIds });

    // 200 on an unchanged retry, 201 on a hold that was created — a double-click
    // should not read as two creations.
    return responseHandler(
        hold,
        res,
        hold.alreadyHeld ? "Hold already exists" : "Tickets held",
        hold.alreadyHeld ? 200 : 201
    );
};

export const releaseTickets = async (req, res) => {
    const userId = requireUserId(req);
    const { eventId, ticketIds } = decodeHoldId(req.params.id);

    const released = await holdService.release({ userId, eventId, ticketIds });
    return responseHandler(released, res, "Hold released", 200);
};

// Diagnostic read for the acceptance tests. Week 2 Day 2 composes this with
// ticket rows from Postgres to serve the real seat map from Event Service.
export const listHolds = async (req, res) => {
    const { eventId } = req.params;
    if (!/^\d+$/.test(eventId)) {
        throw createApiError("eventId must be a positive integer", 422);
    }

    const holds = await getLiveHolds(eventId);
    return responseHandler({ eventId, holds }, res, "Live holds fetched", 200);
};
