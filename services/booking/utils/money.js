import { createApiError } from "./apiError.js";

// pg returns NUMERIC as a string precisely so it does not lose precision in a
// float64. Parsing to Number to add prices would reintroduce the error the
// column type exists to avoid, so totals are summed in integer cents.
export const toCents = (price) => {
    const text = String(price).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(text)) {
        throw createApiError(`Unexpected price format from database: ${price}`, 500);
    }
    const [whole, fraction = ""] = text.split(".");
    return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};

export const fromCents = (cents) =>
    `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

// Server-derived total, per invariant 7. The client never sends an amount, and
// the value passed to Postgres is a string so it lands in NUMERIC(10,2) exactly.
export const sumPrices = (prices) =>
    fromCents(prices.reduce((total, price) => total + toCents(price), 0));
