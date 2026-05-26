import { NextFunction, Request, Response } from "express";
import {
  createNodeService,
  updateNodeService,
  deleteNodeService,
  getNodesByWorkflowService,
} from "./node.service.js";
import { validateId } from "../../../utils/CustomFunc.js";
import { ApiResponse } from "../../../utils/ApiResponse.js";

export async function createNodeController(req: Request, res: Response, next: NextFunction) {
  try {
    const workflowId = req.params.workflowId;
    validateId(workflowId);
    const node = await createNodeService(workflowId, req.body);
    ApiResponse(res, 201,"Node created successfully", node);
  } catch (error) {
    next(error);
  }
}

export async function updateNodeController(req: Request, res: Response, next: NextFunction) {
  try {
    const nodeId = req.params.id;
    validateId(nodeId);
    const node = await updateNodeService(nodeId, req.body);
    ApiResponse(res, 200,"Node updated successfully", node);
  } catch (error) {
    next(error);
  }
}

export async function deleteNodeController(req: Request, res: Response, next: NextFunction) {
  try {
    const nodeId = req.params.id;
    validateId(nodeId);
    const result = await deleteNodeService(nodeId);
    ApiResponse(res, 200, "Node deleted successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function getNodesByWorkflowController(req: Request, res: Response, next: NextFunction) {
  try {
    const workflowId = req.params.workflowId;
    validateId(workflowId);
    const nodes = await getNodesByWorkflowService(workflowId);
    ApiResponse(res, 200, "Nodes retrieved successfully", nodes);
  } catch (error) {
    next(error);
  }
}