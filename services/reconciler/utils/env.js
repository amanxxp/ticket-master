// `Number(process.env.X) || fallback` is wrong whenever 0 is a legitimate value:
// Number("0") is 0, which is falsy, so an explicit 0 silently becomes the
// fallback. Found by the Week 6 Day 3 drill, which set
// RECONCILE_PENDING_AFTER_SECONDS=0 to sweep immediately and got 120 instead —
// the sweep quietly did nothing and the harness reported it as the reconciler
// failing to recover a stranded payment.
//
// Distinguishes "unset" from "set to zero" by checking the string, then rejects
// anything non-numeric rather than letting NaN propagate into a query.
export const numberFromEnv = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
    }
    return parsed;
};
