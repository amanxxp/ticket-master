import { Router } from "express";
import { joinQueue, getQueuePosition } from "../controllers/queue.controller.js";

const router = Router();

router.post("/join", joinQueue);
router.get("/position", getQueuePosition);

export default router;
