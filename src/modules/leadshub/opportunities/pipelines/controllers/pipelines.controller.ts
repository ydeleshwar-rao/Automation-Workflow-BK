import { Request, Response, NextFunction } from "express";
import * as pipelineService from "../service/pipelines.service.js"
import { ApiResponse } from "../../../../../utils/ApiResponse.js";
import { validateId } from "../../../../../utils/CustomFunc.js";
import { getLocationIdByUserId, getUserId } from "../../../../../common/function.js";





export async function syncPipelinesController(req : Request, res: Response, next: NextFunction) {
   try {
    const userId = await getUserId(req);
    const locationId = await getLocationIdByUserId(userId);
    if (!locationId || typeof locationId !== 'string') {
        return res.status(400).json({
            success: false,
            message: "Invalid or missing locationId parameter",
        });
    }
    const getData = await pipelineService.syncPipeLines(locationId);
    return ApiResponse(res, 200, "Pipelines synced successfully", null);

   } catch(error){
    next (error);
   }
}

export async function getPipelinesController(req : Request, res: Response, next: NextFunction) {
    try {
     const userId = await getUserId(req);
     console.log("🟢 [getPipelinesController] userId:", userId);
     const locationId = await getLocationIdByUserId(userId);
     console.log("🟢 [getPipelinesController] resolved locationId:", locationId);
     const getData = await pipelineService.getPipelinesService(locationId);
     return ApiResponse(res, 200, "Pipelines retrieved successfully", getData);
} catch (error) {
        next(error);
    }
}