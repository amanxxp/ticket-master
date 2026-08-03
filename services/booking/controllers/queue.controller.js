import * as queueService from "../services/queue.service.js";
import { responseHandler } from "../utils/response.js";
import { requireUserId } from "../validators/booking.validator.js";
import { validateJoinQueue, validatePositionQuery } from "../validators/queue.validator.js";
import { createApiError } from "../utils/apiError.js";

export const joinQueue = async (req, res) => {
    const userId = requireUserId(req);
    const { eventId } = validateJoinQueue(req.body);
    const result = await queueService.join({ eventId, userId });
    // 201 on a genuinely new slot, 200 on a repeat join — mirrors the
    // reserve-hold controller's own "200 on unchanged retry, 201 on created"
    // convention, so a double-click reads the same way across both.
    return responseHandler(
        result,
        res,
        result.joined ? "Joined queue" : "Already in queue",
        result.joined ? 201 : 200
    );
}

export const getQueuePosition = async (req, res) => {
    const userId = requireUserId(req);
    const { eventId } = validatePositionQuery(req.query);
    const token = req.get("x-queue-token");
    if (!token) {
        throw createApiError("missing x-queue-token header", 401);
    }
    const result = await queueService.getQueuePosition({ eventId, userId, token });
    return responseHandler(result, res, "Queue position fetched", 200);
}
