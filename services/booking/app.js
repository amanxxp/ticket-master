import express from "express";
import router from "./routes/index.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { correlationId } from "./middlewares/correlationId.js";
import { requestLogger } from "./middlewares/requestLogger.js";
import "dotenv/config";

const app = express();

app.use(express.json());
app.use(express.urlencoded({extended:true}));
// Liveness only — deliberately does not check Postgres or Redis. A datastore
// blip would otherwise make the orchestrator kill and restart a process that is
// perfectly capable of serving 503s and recovering on its own. Ahead of
// correlationId/requestLogger on purpose — a health probe hitting this every
// few seconds does not need an id or a log line.
app.get("/health", (req, res) => res.json({ status: "ok", service: "booking" }));

app.use(correlationId);
app.use(requestLogger);

app.use(router);
app.use(errorHandler);

export default app;
