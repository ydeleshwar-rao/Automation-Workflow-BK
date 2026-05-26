import { Request, Response, NextFunction } from "express";
import {
  createTagService,
  getTagsByUserService,
  updateTagService,
  deleteTagService,
  addTagToWorkflowService,
  removeTagFromWorkflowService,
  getTagsByWorkflowService,
  getWorkflowsByTagService,
} from "./workflow-tags.service.js";
import { validateId } from "../../../../utils/CustomFunc.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";

// ─── Tag CRUD ───

export async function createTagController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { name, color, user_id } = req.body;
    if (!name || !user_id) {
      return res.status(400).json({ message: "name and user_id are required" });
    }
    const result = await createTagService({ name, color, user_id });
    return ApiResponse(res, 201, "Tag created successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function getTagsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, role } = req.query;
    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }
    const result = await getTagsByUserService(userId as string, role as string | undefined);
    return ApiResponse(res, 200, "Tags retrieved successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function updateTagController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const tagId = req.params.id;
    validateId(tagId);
    const result = await updateTagService(tagId, req.body);
    return ApiResponse(res, 200, "Tag updated successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function deleteTagController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const tagId = req.params.id;
    validateId(tagId);
    const result = await deleteTagService(tagId);
    return ApiResponse(res, 200, "Tag deleted successfully", result);
  } catch (error) {
    next(error);
  }
}

// ─── Workflow ↔ Tag linking ───

export async function addTagToWorkflowController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const workflowId = req.params.workflowId;
    const { tag_id } = req.body;
    validateId(workflowId);
    validateId(tag_id);
    const result = await addTagToWorkflowService(workflowId, tag_id);
    return ApiResponse(res, 201, "Tag added to workflow", result);
  } catch (error) {
    next(error);
  }
}

export async function removeTagFromWorkflowController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { workflowId, tagId } = req.params;
    validateId(workflowId);
    validateId(tagId);
    const result = await removeTagFromWorkflowService(workflowId, tagId);
    return ApiResponse(res, 200, "Tag removed from workflow", result);
  } catch (error) {
    next(error);
  }
}

export async function getTagsByWorkflowController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const workflowId = req.params.workflowId;
    validateId(workflowId);
    const result = await getTagsByWorkflowService(workflowId);
    return ApiResponse(res, 200, "Tags retrieved successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function getWorkflowsByTagController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const tagId = req.params.tagId;
    validateId(tagId);
    const result = await getWorkflowsByTagService(tagId);
    return ApiResponse(res, 200, "Workflows retrieved successfully", result);
  } catch (error) {
    next(error);
  }
}
