// One line per request, always carrying the correlation id — part of the
// "trace one request end-to-end" mechanism: grep every service's stdout for
// the same id and read its whole path through the system.
export const requestLogger = (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        console.log(`[${req.correlationId}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms.toFixed(1)}ms)`);
    });
    next();
};
