import express from "express";
import router from "./routes/index.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import "dotenv/config";

const app = express();

// Liveness only — deliberately does not check Postgres or Redis. A datastore
// blip would otherwise make the orchestrator kill and restart a process that is
// perfectly capable of serving 503s and recovering on its own.
app.get("/health", (req, res) => res.json({ status: "ok", service: "gateway" }));

app.use(router);
app.use(errorHandler);

export default app;
