// workflow.router.ts

import { Router } from "express";
import {
  createWorkflowController,
  getWorkflowByIdController,
  getWorkflowsController,
  updateWorkflowController,
  deleteWorkflowController,
  activateWorkflowController,
  bulkMoveWorkflowsController,
  reorderWorkflowsController,
} from "./workflow.controller.js";

const router = Router();

router.post("/create", createWorkflowController);
router.get("/getAllworkflows", getWorkflowsController);
router.post("/workflows/bulk-move", bulkMoveWorkflowsController);
router.post("/workflows/reorder", reorderWorkflowsController);
router.get("/workflows/:id", getWorkflowByIdController);
router.patch("/workflows/:id", updateWorkflowController);
router.delete("/workflows/:id", deleteWorkflowController);
router.post("/workflows/:id/activate", activateWorkflowController);

export default router;
