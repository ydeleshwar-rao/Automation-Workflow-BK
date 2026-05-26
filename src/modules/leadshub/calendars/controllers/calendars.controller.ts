import { Request, Response, NextFunction } from "express";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import { getLocationIdByUserId, getUserId } from "../../../../common/function.js";
import { getCalendarsService } from "../service/calendars.service.js";

export async function getCalendarsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = await getUserId(req);
    const locationId = await getLocationIdByUserId(userId);
    const calendars = await getCalendarsService(locationId);

    return ApiResponse(res, 200, "Calendars retrieved successfully", calendars);
  } catch (error) {
    next(error);
  }
}
