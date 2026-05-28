// ai-workflow.router.ts
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import {
  createAiWorkflow,
  getAiWorkflows,
  getAiWorkflowById,
  updateAiWorkflow,
  deleteAiWorkflow,
  runAiWorkflow,
  getAiWorkflowExecutions,
  updateExecution,
} from "./ai-workflow.controller.js";

const router = Router();

// ── Workflow CRUD ─────────────────────────────────────────────
router.post("/",             createAiWorkflow);          // POST   /ai-workflow
router.get("/",              getAiWorkflows);            // GET    /ai-workflow?userId=...
router.get("/:id",           getAiWorkflowById);         // GET    /ai-workflow/:id
router.patch("/:id",         updateAiWorkflow);          // PATCH  /ai-workflow/:id
router.delete("/:id",        deleteAiWorkflow);          // DELETE /ai-workflow/:id

// ── Execution ─────────────────────────────────────────────────
router.post("/:id/run",                         runAiWorkflow);             // POST   /ai-workflow/:id/run
router.get("/:id/executions",                   getAiWorkflowExecutions);  // GET    /ai-workflow/:id/executions
router.patch("/:id/executions/:execId",         updateExecution);           // PATCH  /ai-workflow/:id/executions/:execId

export default router;
