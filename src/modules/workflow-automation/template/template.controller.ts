// template.controller.ts

import { Request, Response, NextFunction } from "express";
import {
  createTemplateFromWorkflowService,
  listTemplatesService,
  getTemplateByIdService,
  updateTemplateService,
  deleteTemplateService,
  applyTemplateService,
} from "./template.service.js";
import { ApiResponse } from "../../../utils/ApiResponse.js";
import { validateId } from "../../../utils/CustomFunc.js";


export async function createTemplateController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { source_workflow_id, name, created_by } = req.body;
    if (!source_workflow_id || !name || !created_by) {
      return res
        .status(400)
        .json({ message: "source_workflow_id, name, and created_by are required" });
    }

    const result = await createTemplateFromWorkflowService(req.body);
    return ApiResponse(res, 201, "Template created successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function listTemplatesController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await listTemplatesService(req.query as any);
    return ApiResponse(res, 200, "Templates retrieved successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function getTemplateByIdController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id;
    validateId(id);
    const result = await getTemplateByIdService(id);
    return ApiResponse(res, 200, "Template retrieved successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function updateTemplateController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id;
    validateId(id);
    const result = await updateTemplateService(id, req.body);
    return ApiResponse(res, 200, "Template updated successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function deleteTemplateController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id;
    validateId(id);
    const result = await deleteTemplateService(id);
    return ApiResponse(res, 200, "Template deleted successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function applyTemplateController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id;
    validateId(id);

    const { name, user_id } = req.body;
    if (!name || !user_id) {
      return res.status(400).json({ message: "name and user_id are required" });
    }

    const result = await applyTemplateService(id, req.body);
    return ApiResponse(res, 201, "Template applied successfully", result);
  } catch (error) {
    next(error);
  }
}
