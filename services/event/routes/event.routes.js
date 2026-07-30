import Router from "express";
import { getEvents } from "../controllers/event.controller.js";

const router = Router();

router.route('/').get(getEvents)

export default router;
