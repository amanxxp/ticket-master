// Shared by every public availability route (seatmap, stream): reads x-user-id
// if present but never 401s on its absence — a guest is a valid caller, they
// just don't get "held by you" labeling. Same header convention the required
// (401-on-missing) routes use in Booking Service.
const ID_PATTERN = /^\d+$/;

export const optionalViewerId = (req) => {
    const raw = req.get("x-user-id");
    return ID_PATTERN.test(raw ?? "") ? raw : null;
};
