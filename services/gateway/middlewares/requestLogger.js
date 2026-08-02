// One line per request, always carrying the correlation id — this is the
// mechanism behind "trace one request end-to-end using only that id": grep
// every service's stdout for the same id and read its whole path through the
// system, gateway included.
export const requestLogger = (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        console.log(`[${req.correlationId}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms.toFixed(1)}ms)`);
    });
    next();
};
