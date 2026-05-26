import { Router } from "express";
import {
  getExecutionsController,
  getExecutionController,
  triggerExecutionController,
  testActionController,
} from "./execution.controller.js";

const router = Router();

router.post("/test-action", testActionController);
router.get("/:id/executions", getExecutionsController);
router.get("/executions/:id", getExecutionController);
router.post("/:id/execute", triggerExecutionController);

export default router;