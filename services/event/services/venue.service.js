import { createApiError } from "../utils/apiError.js";
import {
    insertVenue,
    getVenues,
    getVenueById,
    updateVenue,
    softDeleteVenue,
    countActiveEventsForVenue,
} from "../repositories/venue.repository.js";

// Postgres error codes worth surfacing to the client instead of a generic 500.
const PG_ERROR_STATUS = {
    '23505': 409, // unique_violation
    '23503': 400, // foreign_key_violation
    '23514': 400, // check_violation
};

const rethrowPgError = (error, action) => {
    const status = PG_ERROR_STATUS[error.code];
    if (status) {
        throw createApiError(`Could not ${action} venue: ${error.detail ?? error.message}`, status);
    }
    console.error(`Error during venue ${action}`, error);
    throw error;
};

export const createVenue = async ({ name, location, seatMap }) => {
    try {
        return await insertVenue({ name, location, seatMap });
    } catch (error) {
        rethrowPgError(error, "create");
    }
};

export const getAllVenues = async ({ cursor, pageSize }) => {
    return await getVenues({ cursor, pageSize });
};

export const getVenue = async (id) => {
    const venue = await getVenueById(id);
    if (!venue) {
        throw createApiError(`Venue ${id} not found`, 404);
    }
    return venue;
};

export const editVenue = async (id, changes) => {
    try {
        const venue = await updateVenue(id, changes);
        if (!venue) {
            throw createApiError(`Venue ${id} not found`, 404);
        }
        return venue;
    } catch (error) {
        if (error.isApiError) throw error;
        rethrowPgError(error, "update");
    }
};

export const removeVenue = async (id) => {
    // Checked before the delete rather than relying on the FK: the delete is a
    // soft one, so Postgres would let it through and quietly break those events.
    const activeEvents = await countActiveEventsForVenue(id);
    if (activeEvents > 0) {
        throw createApiError(
            `Cannot delete venue ${id}: ${activeEvents} active event(s) reference it`,
            409
        );
    }

    const deleted = await softDeleteVenue(id);
    if (!deleted) {
        throw createApiError(`Venue ${id} not found`, 404);
    }
    return { id: deleted.id };
};
