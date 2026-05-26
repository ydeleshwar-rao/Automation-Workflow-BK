import { Request, Response, NextFunction } from "express";
import { createWebhookService, processIncomingWebhook, updateWebhookService, getNextPendingWebhookEvent } from "../service/webhook.service.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";

function validateLocationId(locationId: string | string[] | undefined): asserts locationId is string {
  if (!locationId || typeof locationId !== "string") {
    throw new Error("Valid locationId is required");
  }
}

export async function handleCreateWebhook(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { name, action_type, workflow_id, user_id  } = req.body;
    const result = await createWebhookService({ name, action_type, workflow_id, user_id });
    return ApiResponse(res, 200, "New Webhook Url Created", result);
  } catch (error) {
    next(error);
  }
}

export const handleIncomingWebhook = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hookPath = req.params.hookPath;

    if (!hookPath || typeof hookPath !== "string") {
      return res.status(400).json({ success: false, message: "Invalid webhook path" });
    }

    const event = await processIncomingWebhook({
      hookPath,
      headers: req.headers,
      body: req.body,
    });

    ApiResponse(res, 200, "Webhook processed successfully", event);
  } catch (error) {
    next(error);
  }
};

export const handleGetWebhookById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { webhookId } = req.params;
    validateLocationId(webhookId);
    const getData = await getNextPendingWebhookEvent(webhookId);
    return ApiResponse(res, 200, "Pending webhook events fetched successfully", getData);
  } catch (error) {
    next(error);
  }
};

export const handleUpdateWebhook = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ success: false, message: "Invalid webhook id" });
    }

    const { mode, status, request_body } = req.body;
    const updated = await updateWebhookService(id, { mode, status, request_body });
    return ApiResponse(res, 200, "Webhook updated successfully", updated);
  } catch (error) {
    next(error);
  }
};
