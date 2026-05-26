import { NextFunction, Request, Response } from "express";
import {
  getExecutionsByWorkflowService,
  getExecutionByIdService,
  triggerWorkflowExecutionService,
} from "./execution.service.js";
import { validateId } from "../../../utils/CustomFunc.js";
import { ApiResponse } from "../../../utils/ApiResponse.js";
import { getUserId } from "../../../common/function.js";
import { executeAction } from "../processor/webhookProcessor.js";


export async function getExecutionsController(req: Request, res: Response, next: NextFunction) {
  try {
    const workflowId = req.params.id;
    validateId(workflowId);
    const executions = await getExecutionsByWorkflowService(workflowId);
    ApiResponse(res, 200,"Executions retrieved successfully", executions);
  } catch (error) {
    next(error);
  }
}

export async function getExecutionController(req: Request, res: Response, next: NextFunction) {
  try {
    const executionId = req.params.id;
    validateId(executionId);
    const execution = await getExecutionByIdService(executionId);
    ApiResponse(res, 200, "Execution retrieved successfully", execution);
  } catch (error) {
    next(error);
  }
}

export async function triggerExecutionController(req: Request, res: Response, next: NextFunction) {
  try {
    const workflowId = req.params.id;
    validateId(workflowId);
    const clientId = await getUserId(req);
    const triggerData = req.body?.trigger_data ?? req.body ?? {};
    const result = await triggerWorkflowExecutionService(workflowId, clientId, triggerData);
    ApiResponse(res, 202, "Workflow execution started", result);
  } catch (error) {
    next(error);
  }
}

export async function testActionController(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = await getUserId(req);
    const { integration_key, action_key, config, input } = req.body ?? {};

    if (!integration_key || !action_key) {
      return ApiResponse(res, 400, "Missing required fields: integration_key, action_key");
    }

    const node = {
      integration_key,
      action_key,
      config: config ?? {},
      user_id: userId,
    };
    const resolvedInput = input ?? config ?? {};

    console.log(
      `[TestAction] ▶ integration=${integration_key} action=${action_key} user=${userId}`
    );

    const result = await executeAction(node, resolvedInput);

    console.log(`[TestAction] ✓ complete`);
    return ApiResponse(res, 200, "Action test executed", result);
  } catch (error: any) {
    console.error(`[TestAction] ✖ failed`, error?.message);
    next(error);
  }
}