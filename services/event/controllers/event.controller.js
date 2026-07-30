import * as eventService from "../services/event.service.js"
import { responseHandler } from "../utils/response.js";

export const createEvent = async (req, res) => {
    const { name, description, venueId, performerId, eventDate, maxTicketsPerUser } = req.body;
    const event = await eventService.createEvent({
        name, description, venueId, performerId, eventDate, maxTicketsPerUser
    });
    return responseHandler(event, res, "Event created successfully", 201);
}

export const getEvents = async (req, res) => {
    const { cursorDate, cursorId, pageSize, venueId, performerId, upcoming } = req.validatedQuery;
    const events = await eventService.getAllEvents({
        cursorDate, cursorId, pageSize, venueId, performerId, upcoming
    });
    return responseHandler(events, res, "All events fetched", 200);
}

export const getEventById = async (req, res) => {
    const { id } = req.validatedParams;
    const event = await eventService.getEvent(id);
    return responseHandler(event, res, "Event fetched successfully", 200);
}

export const updateEvent = async (req, res) => {
    const { id } = req.validatedParams;
    // Passed through as-is, not destructured: the repository distinguishes
    // "description omitted" from "description set to null", and rebuilding the
    // object here would turn every omitted key into an explicit undefined.
    const event = await eventService.editEvent(id, req.body);
    return responseHandler(event, res, "Event updated successfully", 200);
}

export const deleteEvent = async (req, res) => {
    const { id } = req.validatedParams;
    const result = await eventService.removeEvent(id);
    return responseHandler(result, res, "Event deleted successfully", 200);
}
