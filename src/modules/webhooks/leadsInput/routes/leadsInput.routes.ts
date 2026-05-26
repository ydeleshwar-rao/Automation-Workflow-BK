import { Router } from "express";
import { getleadInputController,leadInputController } from "../controllers/leadsInput.controller.js";

const router = Router();

router.post("/leadinput", leadInputController);
router.get("/getleadinput",getleadInputController)

export default router;
