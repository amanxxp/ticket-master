import { createApiError } from "./apiError.js";

// Bounds one mint request. The seed script builds 50k-ticket events, so this is
// sized to allow that in a single call while still refusing a runaway seat_map.
export const MAX_TICKETS_PER_MINT = 50000;

export const seatLabel = (section, row, index) => `${section}-${row}${index}`;

// Flattens a venue seat_map into the concrete ticket rows it implies.
// Pure: no db, no clock — the price table is resolved here so the caller only
// deals with a finished list.
export const expandSeatMap = (seatMap, { defaultPrice, pricing = [] }) => {
    const sections = seatMap?.sections;
    if (!Array.isArray(sections) || sections.length === 0) {
        throw createApiError("Venue seat_map has no sections to generate tickets from", 422);
    }

    const priceBySection = new Map(pricing.map((p) => [p.section, p.price]));

    const tickets = [];
    for (const section of sections) {
        const price = priceBySection.get(section.name) ?? defaultPrice;
        // Falling back to 0 would silently mint free seats, so an unpriced
        // section is an error the caller has to resolve.
        if (price === undefined) {
            throw createApiError(
                `No price for section "${section.name}" — add it to pricing or set defaultPrice`,
                422
            );
        }

        for (const row of section.rows ?? []) {
            for (let i = 1; i <= row.seats; i++) {
                tickets.push({ seat: seatLabel(section.name, row.label, i), price });
            }
        }

        if (tickets.length > MAX_TICKETS_PER_MINT) {
            throw createApiError(
                `seat_map expands to more than ${MAX_TICKETS_PER_MINT} seats — split the mint`,
                422
            );
        }
    }

    if (tickets.length === 0) {
        throw createApiError("Venue seat_map has no rows to generate tickets from", 422);
    }

    // A seat_map with two sections sharing a name, or one section repeating a row
    // label, collides on UNIQUE (event_id, seat) — ON CONFLICT DO NOTHING would
    // hide it as a skip. Caught here so the response names the actual problem.
    const seen = new Set();
    for (const { seat } of tickets) {
        if (seen.has(seat)) {
            throw createApiError(`seat_map produces duplicate seat "${seat}"`, 422);
        }
        seen.add(seat);
    }

    return tickets;
};
