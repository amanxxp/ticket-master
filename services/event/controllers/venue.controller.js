import { responseHandler } from "../utils/response.js"
import * as venueService from "../services/venue.service.js";

export const createVenue = async (req, res) => {
    const { name, location, seatMap } = req.body;
    const venue = await venueService.createVenue({ name, location, seatMap });
    return responseHandler(venue, res, "Venue created successfully", 201);
}

export const getAllVenues = async (req, res) => {
    const { cursor, pageSize } = req.validatedQuery;
    const venues = await venueService.getAllVenues({ cursor, pageSize });
    return responseHandler(venues, res, "All venue fetched", 200);
}

export const getVenueById = async (req, res) => {
    const { id } = req.validatedParams;
    const venue = await venueService.getVenue(id);
    return responseHandler(venue, res, "Venue fetched successfully", 200);
}

export const updateVenue = async (req, res) => {
    const { id } = req.validatedParams;
    const { name, location, seatMap } = req.body;
    const venue = await venueService.editVenue(id, { name, location, seatMap });
    return responseHandler(venue, res, "Venue updated successfully", 200);
}

export const deleteVenue = async (req, res) => {
    const { id } = req.validatedParams;
    const result = await venueService.removeVenue(id);
    return responseHandler(result, res, "Venue deleted successfully", 200);
}
