import { Request, Response, NextFunction } from "express";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import * as leadInputService from "../service/leadsInput.service.js";
import { getLocationIdByUserId, getUserId } from "../../../../common/function.js";
// interface LeadParams {
//   locationId: string;
// }

// export async function leadInputController(
//   req: Request<LeadParams>,
//   res: Response,
//   next: NextFunction
// )
export async function leadInputController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    console.log("webhook leadInput controller called");

    const { locationId } = req.params;

    if (!locationId || typeof locationId !== "string") {
      throw new Error("locationId is required");
    }
    if (Array.isArray(locationId)) {
  throw new Error("Invalid locationId");
}

    const createDTO = {
      payload: req.body,
      headers: req.headers,
      source: req.headers.origin || "unknown",
    };

    const result = await leadInputService.createLeadInput(
      locationId,
      createDTO
    );

    return ApiResponse(res, 200, "Webhook stored successfully", result);
  } catch (error) {
    next(error);
  }
}


export async function getleadInputController(
  req: Request,
  res: Response,
  next: NextFunction
){
  const userId = await getUserId(req);
 const locationId = await getLocationIdByUserId(userId);

  const getleadInput = await leadInputService.getLeadInputService(locationId);

  return ApiResponse(res,200,"fetched lead input succesfully",getleadInput);


}