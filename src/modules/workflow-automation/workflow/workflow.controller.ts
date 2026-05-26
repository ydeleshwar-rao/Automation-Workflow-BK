// workflow.controller.ts

import { Request, Response, NextFunction } from "express";
import {
  createWorkflowService,
  getWorkflowByIdService,
  getWorkflowsService,
  updateWorkflowService,
  deleteWorkflowService,
  activateWorkflowService,
  bulkMoveWorkflowsService,
  reorderWorkflowsService,
} from "./workflow.service.js";
import { validateId } from "../../../utils/CustomFunc.js";
import { ApiResponse } from "../../../utils/ApiResponse.js";
import { getUserId } from "../../../common/function.js";
import { supabase } from "../../../config/db.config.js";

export async function createWorkflowController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const payload = req.body
    const result = await createWorkflowService(payload);
    return ApiResponse(res, 201,"Workflow created successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function getWorkflowByIdController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const workflowId = req.params.id;
    validateId(workflowId);
    const result = await getWorkflowByIdService(workflowId);
    return ApiResponse(res, 200, "Workflow retrieved successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function getWorkflowsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ message: "userId required" });
    }

    const result = await getWorkflowsService(
      userId as string
    );

    return ApiResponse(res, 200,"Workflows retrieved successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function updateWorkflowController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const workflowId = req.params.id;
    validateId(workflowId);

    // Resolve editor identity — best-effort, never blocks the save
    let last_edited_by: string | undefined;
    let last_edited_by_name: string | undefined;
    try {
      const userId = await getUserId(req);
      if (userId) {
        last_edited_by = userId;
        const { data: profile } = await supabase
          .from("profiles")
          .select("first_name, last_name")
          .eq("id", userId)
          .single();
        if (profile) {
          last_edited_by_name =
            [profile.first_name, profile.last_name].filter(Boolean).join(" ") || undefined;
        }
      }
    } catch {
      // Non-fatal: tracking is best-effort
    }

    const result = await updateWorkflowService(workflowId, {
      ...req.body,
      ...(last_edited_by && { last_edited_by, last_edited_by_name }),
    });

    return ApiResponse(res, 200, "Workflow updated successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function deleteWorkflowController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const workflowId = req.params.id;
    validateId(workflowId);
    const result = await deleteWorkflowService(workflowId);

    return ApiResponse(res, 200,"Workflow deleted successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function activateWorkflowController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const workflowId = req.params.id;
    validateId(workflowId);
    const result = await activateWorkflowService(workflowId);

    return ApiResponse(res, 200,"Workflow activated successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function bulkMoveWorkflowsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { ids, folder_id } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array is required" });
    }
    const result = await bulkMoveWorkflowsService({
      ids,
      folder_id: folder_id ?? null,
    });
    return ApiResponse(res, 200, "Workflows moved successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function reorderWorkflowsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ message: "items array is required" });
    }
    const result = await reorderWorkflowsService({ items });
    return ApiResponse(res, 200, "Workflows reordered successfully", result);
  } catch (error) {
    next(error);
  }
}