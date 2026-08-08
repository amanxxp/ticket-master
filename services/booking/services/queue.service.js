import { randomBytes } from "node:crypto";
import { createApiError } from "../utils/apiError.js";
import { signQueueToken, verifyQueueToken } from "../utils/queueToken.js";
import { signAdmissionToken } from "../utils/admissionToken.js";
import { getEvent, claimDrawSeed } from "../repositories/booking.repository.js";
import {
    joinQueue,
    getPosition,
    countRecentDepartures,
    isAdmitted,
    isSoldOut,
    registerForDraw,
    isRegistered,
    countRegistrants,
    isDrawDone,
    runDraw,
    lateJoinDraw,
} from "../repositories/queue.repository.js";

// Two window sizes rather than one — a long baseline and a shorter recent
// signal — so the two rates they produce can genuinely differ instead of one
// number reported with false confidence. `SHORT` is capped at `LONG` so a
// misconfigured env (a short window bigger than the long one) can't invert
// the range.
const LONG_WINDOW_MS = Number(process.env.QUEUE_DRAIN_WINDOW_MS) || 300000;
const SHORT_WINDOW_MS = Math.min(60000, LONG_WINDOW_MS);

// 32 bytes of CSPRNG output. The seed's only job is to not exist, in any
// derivable form, until sale-open — see claimDrawSeed for why that, rather than
// the hash, is what makes a position unguessable in advance.
const generateSeed = () => randomBytes(32).toString("hex");

const beforeSaleOpen = (event) =>
    event.saleOpensAt !== null && new Date(event.saleOpensAt).getTime() > Date.now();

// Resolves the seed for an event whose sale has opened, generating it on the
// first call and returning whatever is already there on every later one.
// Returns null if Postgres refuses the claim, which means sale_opens_at has not
// actually passed by the database's clock — the caller treats that as "still in
// the registration window" rather than trusting its own clock.
const resolveSeed = async (event) => {
    if (event.drawSeed) return event.drawSeed;
    const claimed = await claimDrawSeed(event.id, generateSeed());
    if (claimed) return claimed;
    return (await getEvent(event.id))?.drawSeed ?? null;
};

// Ensures the registration set has been scored into the waiting ZSET. Safe to
// call on every request: the draw itself is guarded by a flag set inside the
// same script that scores, so only the first call does work.
const ensureDrawn = async (event, seed) => {
    if (await isDrawDone(event.id)) return;
    await runDraw(event.id, seed);
};

export const join = async ({ eventId, userId }) => {
    const event = await getEvent(eventId);
    if (!event) {
        throw createApiError(`Event ${eventId} not found`, 404);
    }

    // The token is reissued on every join, including a repeat one — it is
    // stateless (nothing server-side records "the" current token for a user),
    // so a reissue costs nothing and there is no staleness to worry about: any
    // token whose claims still match a live queue membership verifies the same
    // way. Signed for every branch below, including registration, because a
    // registrant needs to be able to poll before any position exists.
    const token = signQueueToken({ userId, eventId });

    if (event.queueMode === "lottery") {
        if (beforeSaleOpen(event)) {
            // No position is returned, and none exists. Returning even a
            // provisional one here would be a number that must later change,
            // and the queue's contract is that a position never worsens once
            // shown — the way to keep that promise is to show nothing yet.
            const registered = await registerForDraw(eventId, userId);
            return {
                token,
                status: "registered",
                position: null,
                joined: registered === 1,
                registrants: await countRegistrants(eventId),
                saleOpensAt: event.saleOpensAt,
            };
        }

        const seed = await resolveSeed(event);
        if (!seed) {
            // Postgres declined the seed claim, so by the database's clock the
            // sale has not opened. This service's clock disagreeing is not a
            // reason to open the draw early.
            const registered = await registerForDraw(eventId, userId);
            return {
                token,
                status: "registered",
                position: null,
                joined: registered === 1,
                registrants: await countRegistrants(eventId),
                saleOpensAt: event.saleOpensAt,
            };
        }

        // The draw runs first, so a caller arriving in the same instant the
        // window closes is scored as a registrant rather than appended behind
        // the very set they belonged to.
        await ensureDrawn(event, seed);
        const position = await lateJoinDraw(eventId, userId);
        return { token, status: "waiting", position, joined: true };
    }

    const result = await joinQueue(eventId, userId);
    return { token, status: "waiting", position: result.position, joined: result.joined };
};

// No departures observed yet in EITHER window is reported as exactly that —
// not `position / assumed_rate`. Before the admitter runs, this is always the
// case; the honest answer is "not enough data," not a number that looks
// precise but is actually a guess dressed up as a measurement.
const estimateEta = async (eventId, position) => {
    const [longCount, shortCount] = await Promise.all([
        countRecentDepartures(eventId, LONG_WINDOW_MS),
        countRecentDepartures(eventId, SHORT_WINDOW_MS),
    ]);

    const rates = [
        longCount / (LONG_WINDOW_MS / 1000),
        shortCount / (SHORT_WINDOW_MS / 1000),
    ].filter((rate) => rate > 0);

    if (rates.length === 0) {
        return { etaSecondsMin: null, etaSecondsMax: null, etaMessage: "Not enough drain data yet" };
    }

    return {
        etaSecondsMin: Math.ceil(position / Math.max(...rates)),
        etaSecondsMax: Math.ceil(position / Math.min(...rates)),
    };
};

export const getQueuePosition = async ({ eventId, userId, token }) => {
    let claims;
    try {
        claims = verifyQueueToken(token);
    } catch {
        throw createApiError("Invalid or expired queue token", 401);
    }

    // Both checks are 401, deliberately, not 403 or 404 — a mismatched token
    // proves nothing about the caller's right to ask, the same way a
    // tampered access token does elsewhere in this system. It does not say
    // "this queue entry doesn't exist" (404) or "you're not allowed" (403);
    // it says "this credential isn't yours."
    if (claims.userId !== userId) {
        throw createApiError("This queue token does not belong to you", 401);
    }
    if (String(claims.eventId) !== String(eventId)) {
        throw createApiError("This queue token is for a different event", 401);
    }

    // Lottery mode, sale not yet open by the database's clock: this caller is a
    // registrant with no position, and polling must say so rather than 404. The
    // draw is also kicked here, not only from join(), so a registrant who polls
    // as the window closes gets their position on that very poll instead of
    // having to wait for somebody else to join and trigger it.
    const event = await getEvent(eventId);
    if (event?.queueMode === "lottery" && !(await isDrawDone(eventId))) {
        const registered = await isRegistered(eventId, userId);
        const seed = beforeSaleOpen(event) ? null : await resolveSeed(event);

        if (!seed) {
            if (!registered) {
                throw createApiError("You are not registered for this event's draw", 404);
            }
            return {
                status: "registered",
                position: null,
                registrants: await countRegistrants(eventId),
                saleOpensAt: event.saleOpensAt,
            };
        }
        await ensureDrawn(event, seed);
    }

    const position = await getPosition(eventId, userId);
    if (position !== null) {
        const eta = await estimateEta(eventId, position);
        return { status: "waiting", position, ...eta };
    }

    // No longer in the waiting ZSET — the admitter (a separate process) is the
    // only thing that removes members, and it does so for exactly one of two
    // reasons: it let this user in, or the event sold out and drained
    // everyone. Checked in this order because a race where both happen to be
    // true (sold out right as this user was admitted) should still favor
    // telling them the good news — they have a real, usable admission token.
    if (await isAdmitted(eventId, userId)) {
        const admissionToken = signAdmissionToken({ userId, eventId });
        return { status: "admitted", admissionToken };
    }
    if (await isSoldOut(eventId)) {
        return { status: "sold_out" };
    }

    // Neither admitted nor sold out, and not waiting — this user was never in
    // this event's queue at all.
    throw createApiError("You are not in this event's queue", 404);
};
