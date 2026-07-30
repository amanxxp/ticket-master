import * as ticketService from "../services/ticket.service.js";
import { responseHandler } from "../utils/response.js";

export const createTickets = async (req, res) => {
    const { eventId } = req.validatedParams;
    const result = await ticketService.createTickets(eventId, req.body.tickets);
    return responseHandler(result, res, "Tickets created successfully", 201);
}

export const generateTickets = async (req, res) => {
    const { eventId } = req.validatedParams;
    const { defaultPrice, pricing } = req.body;
    const result = await ticketService.generateTickets(eventId, { defaultPrice, pricing });
    return responseHandler(result, res, "Tickets generated from seat map", 201);
}

export const getTickets = async (req, res) => {
    const { eventId } = req.validatedParams;
    const { cursor, pageSize, status } = req.validatedQuery;
    const tickets = await ticketService.getAllTickets({ eventId, cursor, pageSize, status });
    return responseHandler(tickets, res, "Tickets fetched", 200);
}

export const getTicketById = async (req, res) => {
    const { eventId, ticketId } = req.validatedParams;
    const ticket = await ticketService.getTicket(eventId, ticketId);
    return responseHandler(ticket, res, "Ticket fetched successfully", 200);
}

export const updateTicket = async (req, res) => {
    const { eventId, ticketId } = req.validatedParams;
    const ticket = await ticketService.editTicketPrice(eventId, ticketId, req.body.price);
    return responseHandler(ticket, res, "Ticket updated successfully", 200);
}

export const deleteTicket = async (req, res) => {
    const { eventId, ticketId } = req.validatedParams;
    const result = await ticketService.removeTicket(eventId, ticketId);
    return responseHandler(result, res, "Ticket deleted successfully", 200);
}
