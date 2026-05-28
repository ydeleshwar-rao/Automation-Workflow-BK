// ai-workflow.controller.ts
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, NextFunction } from "express";
import { ApiResponse } from "../../utils/ApiResponse.js";
import {
  createAiWorkflowService,
  getAiWorkflowsService,
  getAiWorkflowByIdService,
  updateAiWorkflowService,
  deleteAiWorkflowService,
  createExecutionService,
  getExecutionsService,
  updateExecutionService,
} from "./ai-workflow.service.js";

// ── Workflows ─────────────────────────────────────────────────────────────────

export async function createAiWorkflow(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await createAiWorkflowService(req.body);
    return ApiResponse(res, 201, "AI Workflow created", data);
  } catch (e) { next(e); }
}

export async function getAiWorkflows(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.status(400).json({ message: "userId required" });
    const data = await getAiWorkflowsService(userId);
    return ApiResponse(res, 200, "AI Workflows retrieved", data);
  } catch (e) { next(e); }
}

export async function getAiWorkflowById(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getAiWorkflowByIdService(req.params.id);
    return ApiResponse(res, 200, "AI Workflow retrieved", data);
  } catch (e) { next(e); }
}

export async function updateAiWorkflow(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await updateAiWorkflowService(req.params.id, req.body);
    return ApiResponse(res, 200, "AI Workflow updated", data);
  } catch (e) { next(e); }
}

export async function deleteAiWorkflow(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await deleteAiWorkflowService(req.params.id);
    return ApiResponse(res, 200, "AI Workflow deleted", data);
  } catch (e) { next(e); }
}

// ── Executions ────────────────────────────────────────────────────────────────

export async function runAiWorkflow(req: Request, res: Response, next: NextFunction) {
  try {
    const execution = await createExecutionService({
      workflow_id: req.params.id,
      trigger: "manual",
    });
    // TODO: queue actual node execution — for now returns the pending execution record
    return ApiResponse(res, 201, "Execution started", execution);
  } catch (e) { next(e); }
}

export async function getAiWorkflowExecutions(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getExecutionsService(req.params.id);
    return ApiResponse(res, 200, "Executions retrieved", data);
  } catch (e) { next(e); }
}

export async function updateExecution(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await updateExecutionService(req.params.execId, req.body);
    return ApiResponse(res, 200, "Execution updated", data);
  } catch (e) { next(e); }
}
