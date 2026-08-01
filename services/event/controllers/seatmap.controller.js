import * as seatmapService from "../services/seatmap.service.js";
import { responseHandler } from "../utils/response.js";
import { optionalViewerId } from "../utils/viewer.js";

export const getSeatMap = async (req, res) => {
    const { id } = req.validatedParams;
    const viewerUserId = optionalViewerId(req);
    const seatMap = await seatmapService.getSeatMap(id, viewerUserId);
    return responseHandler(seatMap, res, "Seat map fetched", 200);
}
