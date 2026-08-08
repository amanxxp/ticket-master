import Stripe from "stripe";

// `fake` runs the same call shapes against an in-process double so the payment
// path — idempotency keys, pending-before-charge ordering, refund transitions —
// is exercisable without network or a live account. It is NOT a bypass: the
// service code below does not branch on it, and the double enforces idempotency
// for real (same key → same result object, one charge).
//
// Chosen by env rather than by sniffing the key, so a misconfigured real key
// fails loudly as a Stripe auth error instead of silently falling back to a fake
// that reports success for money that never moved.
const MODE = process.env.STRIPE_MODE || (process.env.STRIPE_SECRET_KEY?.startsWith("sk_live") ? "live" : "test");

const isFake = MODE === "fake";

// File-backed, NOT an in-memory Map, and that difference is the whole point.
//
// The reconciler runs in its own process. Its entire job is to ask the provider
// "did this booking actually get charged?" about a charge some OTHER process made
// before it died. An in-process Map cannot answer that — the reconciler would see
// an empty provider and conclude no money moved, which is the exact wrong answer
// and would make the most important test in the suite pass vacuously.
//
// A file is the smallest thing that gives the fake the one property that matters
// here: the provider's records outlive and are visible outside the process that
// created them. Deliberately not Redis — the failure drill stops Redis, and a
// provider that vanishes with your cache is not a useful stand-in for Stripe.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const FAKE_STORE = process.env.STRIPE_FAKE_STORE || join(tmpdir(), "tm-fake-stripe.json");

const loadStore = () => {
    try {
        if (!existsSync(FAKE_STORE)) return { intents: {}, refunds: {}, seq: 1 };
        return JSON.parse(readFileSync(FAKE_STORE, "utf8"));
    } catch {
        return { intents: {}, refunds: {}, seq: 1 };
    }
};

const saveStore = (store) => {
    mkdirSync(dirname(FAKE_STORE), { recursive: true });
    writeFileSync(FAKE_STORE, JSON.stringify(store));
};

const fakeStripe = {
    paymentIntents: {
        create: async (params, options) => {
            const store = loadStore();
            const key = options?.idempotencyKey;
            if (key && store.intents[key]) return store.intents[key];

            // `pm_fail_*` is how the acceptance tests drive a declined charge.
            // Stripe raises on a decline rather than returning a failed object,
            // so the double raises too — otherwise the error-handling path would
            // never be exercised.
            if (String(params.payment_method).startsWith("pm_fail")) {
                const err = new Error("Your card was declined.");
                err.type = "StripeCardError";
                err.code = "card_declined";
                throw err;
            }

            const intent = {
                id: `pi_fake_${store.seq++}`,
                status: "succeeded",
                amount: params.amount,
                currency: params.currency,
                metadata: params.metadata ?? {},
            };
            if (key) store.intents[key] = intent;
            saveStore(store);
            return intent;
        },
        retrieve: async (id) => {
            const store = loadStore();
            for (const intent of Object.values(store.intents)) if (intent.id === id) return intent;
            const err = new Error(`No such payment_intent: ${id}`);
            err.code = "resource_missing";
            throw err;
        },
        // The reconciler's fallback when a crash left no provider_ref: the only
        // way to answer "did this booking get charged?" is to ask the provider by
        // the metadata we attached at charge time. Stripe's real API exposes this
        // as `search` with a query language; the double matches the shape it uses.
        search: async ({ query }) => {
            const match = /metadata\['bookingId'\]:'(\d+)'/.exec(query);
            const bookingId = match?.[1];
            const store = loadStore();
            const data = Object.values(store.intents).filter(
                (i) => bookingId && String(i.metadata?.bookingId) === bookingId
            );
            return { data };
        },
    },
    refunds: {
        create: async (params, options) => {
            const store = loadStore();
            const key = options?.idempotencyKey;
            if (key && store.refunds[key]) return store.refunds[key];
            const refund = {
                id: `re_fake_${store.seq++}`,
                status: "succeeded",
                amount: params.amount,
                payment_intent: params.payment_intent,
            };
            if (key) store.refunds[key] = refund;
            saveStore(store);
            return refund;
        },
    },
};

// Fails loudly at boot rather than degrading to the fake. A service that
// silently reports successful payments for money that never moved is worse than
// one that refuses to start.
if (!isFake && !process.env.STRIPE_SECRET_KEY) {
    throw new Error(
        "STRIPE_SECRET_KEY is required unless STRIPE_MODE=fake. " +
        "Set STRIPE_MODE=fake for local development without an account."
    );
}

const realStripe = isFake ? null : new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

export const stripe = isFake ? fakeStripe : realStripe;

// Signature verification is the ONE thing the fake never reimplements. Hand-
// rolling an HMAC compare would be reimplementing exactly the code most worth
// testing against the real library — and an unverified webhook endpoint is a
// free-tickets endpoint, so a subtly-wrong reimplementation is the worst possible
// place to be clever.
//
// `constructEvent` makes no network call, so the real implementation works
// offline. In fake mode it runs against a throwaway instance with a dummy key,
// which is never used for anything else.
const verifier = isFake ? new Stripe("sk_test_offline_verifier_only") : realStripe;

export const constructWebhookEvent = (rawBody, signatureHeader, secret) =>
    verifier.webhooks.constructEvent(rawBody, signatureHeader, secret);
export const STRIPE_MODE = MODE;
export const isFakeStripe = isFake;

if (isFake) {
    console.warn("stripe: FAKE mode — no money moves. Set STRIPE_MODE=test with a real sk_test key for live calls.");
}
