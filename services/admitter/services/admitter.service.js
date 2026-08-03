import { ADMISSION_TTL_SECONDS } from "../../../shared/queue.js";
import { countAvailableTickets } from "../repositories/inventory.repository.js";
import {
    getQueueLength,
    countActiveAdmissions,
    admitBatch,
    markSoldOutAndDrain,
    deregisterIfDrained,
} from "../repositories/queue.repository.js";

// Overbooking compensates for admitted users who never convert (close the tab,
// change their mind, get distracted) — some fraction of every admitted batch
// is expected not to buy, so admitting slightly more than the raw remaining
// count keeps the checkout flow full instead of steadily under-selling as
// no-shows accumulate. 1.1 (10%) is a starting default, not a derived
// constant — the number worth defending is not "1.1 is correct" but "this is
// a config value tuned from observed no-show rate, not a guess baked into
// code." Too high risks real overselling if more people convert than
// expected; too low leaves seats unsold with an empty checkout funnel.
const OVERBOOKING_FACTOR = Number(process.env.OVERBOOKING_FACTOR) || 1.1;

const ADMISSION_TTL_MS = ADMISSION_TTL_SECONDS * 1000;
const DEPARTURES_WINDOW_MS = Number(process.env.QUEUE_DRAIN_WINDOW_MS) || 300000;

// Budget is bounded by what's actually left to sell, not a fixed admit-per-tick
// rate — a fixed rate would keep admitting long after inventory ran out (or
// under-admit while plenty of seats sit free). `remaining * OVERBOOKING_FACTOR`
// is the total number of admission slots this event should ever have open at
// once; subtracting currently-active (non-expired) admissions is what makes a
// released hold or an expired admission free up a new slot on the very next
// tick — "the queue drains at the rate seats actually free," not at a rate
// this code invented.
export const computeBudget = async (eventId) => {
    const available = await countAvailableTickets(eventId);
    const activeAdmissions = await countActiveAdmissions(eventId);
    const budget = Math.floor(available * OVERBOOKING_FACTOR) - activeAdmissions;
    return Math.max(0, budget);
};

// One event, one tick's worth of work. Idempotent to re-run: calling this
// again immediately (e.g. after a crash mid-drain) just recomputes budget
// fresh off current Redis/Postgres state and continues — there is no
// in-memory progress to lose, because none is kept.
export const drainEvent = async (eventId) => {
    const available = await countAvailableTickets(eventId);

    if (available === 0) {
        const drained = await markSoldOutAndDrain(eventId);
        await deregisterIfDrained(eventId);
        return { eventId, soldOut: true, admitted: 0, drained };
    }

    const budget = await computeBudget(eventId);
    if (budget <= 0) {
        return { eventId, soldOut: false, admitted: 0 };
    }

    const queueLength = await getQueueLength(eventId);
    const toAdmit = Math.min(budget, queueLength);
    if (toAdmit === 0) {
        return { eventId, soldOut: false, admitted: 0 };
    }

    const admittedIds = await admitBatch(eventId, toAdmit, ADMISSION_TTL_MS, DEPARTURES_WINDOW_MS);
    await deregisterIfDrained(eventId);
    return { eventId, soldOut: false, admitted: admittedIds.length };
};
