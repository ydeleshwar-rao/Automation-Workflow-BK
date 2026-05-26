// template-folder.controller.ts

import { Request, Response, NextFunction } from "express";
import {
  bulkApplyFolderService,
  createTemplateFolderService,
  deleteTemplateFolderService,
  getRequiredIntegrationsService,
  getUserIntegrationStatusService,
  listTemplateFoldersService,
  updateTemplateFolderService,
} from "./template-folder.service.js";
import { supabase } from "../../../../config/db.config.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import { validateId } from "../../../../utils/CustomFunc.js";

export async function createTemplateFolderController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { name, created_by } = req.body;
    if (!name || !created_by) {
      return res.status(400).json({ message: "name and created_by are required" });
    }
    const result = await createTemplateFolderService(req.body);
    return ApiResponse(res, 201, "Template folder created successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function listTemplateFoldersController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await listTemplateFoldersService(req.query as any);
    return ApiResponse(res, 200, "Template folders retrieved successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function updateTemplateFolderController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id;
    validateId(id);
    const result = await updateTemplateFolderService(id, req.body);
    return ApiResponse(res, 200, "Template folder updated successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function deleteTemplateFolderController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id;
    validateId(id);
    const result = await deleteTemplateFolderService(id);
    return ApiResponse(res, 200, "Template folder deleted successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function getRequiredIntegrationsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { id } = req.params;
    validateId(id);
    const integrations = await getRequiredIntegrationsService(id);
    return ApiResponse(res, 200, "Required integrations retrieved", integrations);
  } catch (error) {
    next(error);
  }
}

export async function getIntegrationStatusController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.params.userId;
    if (!userId) return res.status(400).json({ message: "userId param required" });

    const requestingUser = (req as any).user as { id: string; role: string } | undefined;

    if (!requestingUser) {
      return res.status(401).json({ message: "Unauthorised" });
    }

    // Access control:
    // Admin → any user
    // Developer → only their assigned clients
    // User → only themselves
    if (requestingUser.role === "developer") {
      const { data: access } = await supabase
        .from("user_client_access")
        .select("client_user_id")
        .eq("user_id", requestingUser.id)
        .eq("client_user_id", userId)
        .maybeSingle();

      if (!access) {
        return res.status(403).json({ message: "Access denied: client not assigned to you" });
      }
    } else if (requestingUser.role !== "admin" && requestingUser.id !== userId) {
      return res.status(403).json({ message: "Access denied" });
    }

    // Parse optional filter: ?integrations=service_m8,commusoft
    const filter = req.query.integrations
      ? String(req.query.integrations).split(",").map((s) => s.trim())
      : undefined;

    const status = await getUserIntegrationStatusService(
      String(userId),
      Array.isArray(filter) ? filter : filter ? [filter] : undefined
    );
    return ApiResponse(res, 200, "Integration status retrieved", status);
  } catch (error) {
    next(error);
  }
}

export async function bulkApplyFolderController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id;
    validateId(id);
    const { user_id } = req.body;
    if (!user_id) {
      return res.status(400).json({ message: "user_id is required" });
    }
    const result = await bulkApplyFolderService(id, req.body);
    return ApiResponse(res, 201, "Folder applied successfully", result);
  } catch (error) {
    next(error);
  }
}
