import { Request, Response, NextFunction } from "express";
import * as tagsService from "../service/tag.service.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import { getLocationIdByUserId, getUserId } from "../../../../common/function.js";

export async function getTagsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = await getUserId(req);
    const locationId = await getLocationIdByUserId(userId);
    const data = await tagsService.getTagsService(locationId);

    return ApiResponse(
      res,
      200,
      "Tags fetched successfully",
      data
    );
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
}
