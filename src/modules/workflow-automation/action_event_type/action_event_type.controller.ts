import { NextFunction, Request, Response } from "express";
import {
  getActionLeadshubTypes,
  getLeadshubTriggers,
  getLeadshubActions,
  getServiceM8Triggers,
  getServiceM8Actions,
  getCommusoftTriggers,
  getCommusoftActions,
  getSimproTriggers,
  getSimproActions,
} from "./action_event_type.service.js";
import { ApiResponse } from "../../../utils/ApiResponse.js";

export function getActionTypesLeadshubController(_req: Request, res: Response, next: NextFunction) {
  try {
    const actions = getActionLeadshubTypes();
    ApiResponse(res, 200, "Action types retrieved successfully", actions);
  } catch (error) {
    next(error);
  }
}

export function getLeadshubTriggersController(_req: Request, res: Response, next: NextFunction) {
  try {
    const triggers = getLeadshubTriggers();
    ApiResponse(res, 200, "Leadshub triggers retrieved successfully", triggers);
  } catch (error) {
    next(error);
  }
}

export function getLeadshubActionsController(_req: Request, res: Response, next: NextFunction) {
  try {
    const actions = getLeadshubActions();
    ApiResponse(res, 200, "Leadshub actions retrieved successfully", actions);
  } catch (error) {
    next(error);
  }
}

export function getServiceM8TriggersController(_req: Request, res: Response, next: NextFunction) {
  try {
    const triggers = getServiceM8Triggers();
    ApiResponse(res, 200, "ServiceM8 triggers retrieved successfully", triggers);
  } catch (error) {
    next(error);
  }
}

export function getServiceM8ActionsController(_req: Request, res: Response, next: NextFunction) {
  try {
    const actions = getServiceM8Actions();
    ApiResponse(res, 200, "ServiceM8 actions retrieved successfully", actions);
  } catch (error) {
    next(error);
  }
}

export function getCommusoftTriggersController(_req: Request, res: Response, next: NextFunction) {
  try {
    const triggers = getCommusoftTriggers();
    ApiResponse(res, 200, "Commusoft triggers retrieved successfully", triggers);
  } catch (error) {
    next(error);
  }
}

export function getCommusoftActionsController(_req: Request, res: Response, next: NextFunction) {
  try {
    const actions = getCommusoftActions();
    ApiResponse(res, 200, "Commusoft actions retrieved successfully", actions);
  } catch (error) {
    next(error);
  }
}

export function getSimproTriggersController(_req: Request, res: Response, next: NextFunction) {
  try {
    const triggers = getSimproTriggers();
    ApiResponse(res, 200, "Simpro triggers retrieved successfully", triggers);
  } catch (error) {
    next(error);
  }
}

export function getSimproActionsController(_req: Request, res: Response, next: NextFunction) {
  try {
    const actions = getSimproActions();
    ApiResponse(res, 200, "Simpro actions retrieved successfully", actions);
  } catch (error) {
    next(error);
  }
}
