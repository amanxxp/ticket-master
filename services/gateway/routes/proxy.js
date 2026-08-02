import { createProxyMiddleware } from "http-proxy-middleware";
import { CORRELATION_ID_HEADER } from "../../../shared/correlationId.js";
import { codeForStatus } from "../../../shared/httpError.js";

const DEFAULT_PROXY_TIMEOUT_MS = 10000;

// Exact-segment prefix match — `pathname.indexOf(prefix) === 0` (the library's
// own plain-string mode) would also match "/eventsX", since it's a raw
// substring check with no segment boundary. None of today's five prefixes
// collide that way, but this is cheap to get right rather than rely on it
// never mattering.
const prefixFilter = (prefix) => (pathname) => pathname === prefix || pathname.startsWith(`${prefix}/`);

// One factory, reused for every upstream — each proxied service must forward
// the correlation id and fail the same way (503, same envelope shape as every
// other error in the system), so it is the same middleware config every time,
// parameterized only by target/timeout/name.
export const createUpstreamProxy = ({ name, target, pathFilter, proxyTimeoutMs = DEFAULT_PROXY_TIMEOUT_MS }) =>
    createProxyMiddleware({
        target,
        pathFilter,
        changeOrigin: true,
        // 0 disables the timeout — used only by the SSE stream route, which has
        // no "no response yet" deadline to apply; it is long-lived by design,
        // kept alive by the upstream's own heartbeat, ended by the client
        // disconnecting, not by a timer. A finite value everywhere else bounds
        // how long a hanging downstream can hold a gateway connection open —
        // "a hanging service must not hang the gateway."
        proxyTimeout: proxyTimeoutMs || undefined,
        on: {
            proxyReq: (proxyReq, req) => {
                proxyReq.setHeader(CORRELATION_ID_HEADER, req.correlationId);
            },
            // Supplying this disables http-proxy-middleware's own default error
            // plugin entirely (get-plugins.js skips it whenever `options.on.error`
            // is present) — this is the only thing that ever writes to `res` on a
            // proxy-level failure, so there is no double-write race to guard
            // against from the library's own default behavior.
            error: (err, req, res) => {
                console.error(`[${req?.correlationId}] upstream '${name}' unreachable:`, err.message);

                if (!res || typeof res.writeHead !== "function" || res.headersSent) {
                    // A WebSocket upgrade socket, or a response this request
                    // already answered some other way — nothing left to write
                    // a JSON body onto.
                    res?.destroy?.();
                    return;
                }

                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    error: {
                        code: codeForStatus(503),
                        message: `${name} is temporarily unavailable`,
                        correlationId: req?.correlationId,
                    },
                }));
            },
        },
    });

export const streamPathFilter = (pathname) => /^\/events\/[^/]+\/stream$/.test(pathname);
export { prefixFilter };
