import { NextFunction, Request, Response } from "express";
import {
  createMappingService,
  createMappingsBulkService,
  getMappingsByNodeService,
  deleteMappingService,
} from "./mapping.service.js";
import { validateId } from "../../../utils/CustomFunc.js";
import { ApiResponse } from "../../../utils/ApiResponse.js";

export async function createMappingController(req: Request, res: Response, next: NextFunction) {
  try {
    const nodeId = req.params.id;
    validateId(nodeId);
    const mapping = await createMappingService(nodeId, req.body);
    ApiResponse(res, 201, "Mapping created successfully", mapping);
  } catch (error) {
    next(error);
  }
}

export async function getMappingsController(req: Request, res: Response, next: NextFunction) {
  try {
    const nodeId = req.params.id;
    validateId(nodeId);
    const mappings = await getMappingsByNodeService(nodeId);
    ApiResponse(res, 200, "Mappings retrieved successfully", mappings);
  } catch (error) {
    next(error);
  }
}

export async function createMappingsBulkController(req: Request, res: Response, next: NextFunction) {
  try {
    const nodeId = req.params.id;
    validateId(nodeId);
    const { mappings } = req.body;
    if (!Array.isArray(mappings) || mappings.length === 0) {
      return res.status(400).json({ success: false, message: "mappings must be a non-empty array" });
    }
    const result = await createMappingsBulkService(nodeId, mappings);
    ApiResponse(res, 201, "Mappings saved successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function deleteMappingController(req: Request, res: Response, next: NextFunction) {
  try {
    const nodeId = req.params.id;
    const destinationField = req.params.destinationField as string;
    validateId(nodeId);
    if (!destinationField) {
      return res.status(400).json({ success: false, message: "destinationField param is required" });
    }
    const result = await deleteMappingService(nodeId, destinationField);
    ApiResponse(res, 200, "Mapping deleted successfully", result);
  } catch (error) {
    next(error);
  }
}
