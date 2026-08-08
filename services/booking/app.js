import express from "express";
import router from "./routes/index.js";
import webhookRoutes from "./routes/webhook.routes.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { correlationId } from "./middlewares/correlationId.js";
import { requestLogger } from "./middlewares/requestLogger.js";
import "dotenv/config";

const app = express();

// Webhooks are mounted BEFORE express.json, and this ordering is load-bearing.
// Signature verification runs against the exact bytes Stripe signed; once
// express.json has parsed the body, those bytes are gone and no re-serialisation
// reproduces them (key order and whitespace are both signed). Mounting this after
// express.json would make every webhook fail verification — and the tempting
// "fix" is to stop verifying, which turns this into a free-tickets endpoint.
//
// correlationId runs first so a webhook still gets an id in its logs and errors.
app.use(correlationId);
app.use("/webhooks", webhookRoutes);

app.use(express.json());
app.use(express.urlencoded({extended:true}));
// Liveness only — deliberately does not check Postgres or Redis. A datastore
// blip would otherwise make the orchestrator kill and restart a process that is
// perfectly capable of serving 503s and recovering on its own. Ahead of
// correlationId/requestLogger on purpose — a health probe hitting this every
// few seconds does not need an id or a log line.
app.get("/health", (req, res) => res.json({ status: "ok", service: "booking" }));

app.use(requestLogger);

app.use(router);
app.use(errorHandler);

export default app;
