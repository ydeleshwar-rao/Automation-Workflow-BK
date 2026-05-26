import Router from "express";
import { getCalendarsController } from "../controllers/calendars.controller.js";

const router = Router();

router.get("/all", getCalendarsController);

export default router;
