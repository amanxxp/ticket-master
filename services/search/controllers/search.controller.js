import * as searchService from "../services/search.service.js";
import { validateSearchQuery } from "../validators/search.validator.js";
import { responseHandler } from "../utils/response.js";

export const search = async (req, res) => {
    const filters = validateSearchQuery(req.query);
    const results = await searchService.searchEvents(filters);
    return responseHandler(results, res, "Search results fetched", 200);
}
