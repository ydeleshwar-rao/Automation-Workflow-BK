import { Request, Response, NextFunction } from "express";
import {
  createFolderService,
  getFoldersByUserService,
  updateFolderService,
  deleteFolderService,
  reorderFoldersService,
} from "./folder.service.js";
import { validateId } from "../../../../utils/CustomFunc.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";

export async function createFolderController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { name, user_id, parent_id, position } = req.body;
    if (!name || !user_id) {
      return res.status(400).json({ message: "name and user_id are required" });
    }
    const result = await createFolderService({ name, user_id, parent_id, position });
    return ApiResponse(res, 201, "Folder created successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function getFoldersController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { userId, role } = req.query;
    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }
    const result = await getFoldersByUserService(userId as string, role as string | undefined);
    return ApiResponse(res, 200, "Folders retrieved successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function updateFolderController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const folderId = req.params.id;
    validateId(folderId);
    const result = await updateFolderService(folderId, req.body);
    return ApiResponse(res, 200, "Folder updated successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function deleteFolderController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const folderId = req.params.id;
    validateId(folderId);
    const result = await deleteFolderService(folderId);
    return ApiResponse(res, 200, "Folder deleted successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function reorderFoldersController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ message: "items array is required" });
    }
    const result = await reorderFoldersService({ items });
    return ApiResponse(res, 200, "Folders reordered successfully", result);
  } catch (error) {
    next(error);
  }
}
