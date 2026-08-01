import * as seatmapService from "../services/seatmap.service.js";
import { responseHandler } from "../utils/response.js";

// Public route (REQUIREMENTS.md: GET /events/:id/seatmap is public), so this
// reads x-user-id if present but never 401s on its absence — a guest browsing
// availability is a valid caller, they just don't get the "held by you" label.
const ID_PATTERN = /^\d+$/;
const optionalViewerId = (req) => {
    const raw = req.get("x-user-id");
    return ID_PATTERN.test(raw ?? "") ? raw : null;
};

export const getSeatMap = async (req, res) => {
    const { id } = req.validatedParams;
    const viewerUserId = optionalViewerId(req);
    const seatMap = await seatmapService.getSeatMap(id, viewerUserId);
    return responseHandler(seatMap, res, "Seat map fetched", 200);
}
