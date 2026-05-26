import { Request, Response, NextFunction } from "express";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { getUserId } from "../../common/function.js";
import { validateId } from "../../utils/CustomFunc.js";
import {
  createPollingSubscription,
  getSubscriptionByNodeId,
  updatePollingSubscription,
  deletePollingSubscription,
  pollNowService,
  getSubscriptionStatus,
} from "./polling.service.js";

// ─── Webhook engine bridge ──────────────────────────────────────────────────
// The polling controller is the SINGLE entry point the frontend hits for
// trigger subscriptions. We dispatch to webhook-engine when the integration
// has a webhook adapter, and fall back to polling otherwise. Frontend stays
// unaware of the routing — both delivery modes return the same response shape
// (with a `_delivery_mode` discriminator added so the UI can show a badge).
import {
  supportsWebhook,
  createWebhookSubscription,
  getWebhookSubscriptionById,
  getWebhookSubscriptionByNodeId,
  deleteWebhookSubscription,
  setWebhookSubscriptionActive,
  pollNowForWebhookSubscription,
  getWebhookSubscriptionStatus,
} from "../webhook-engine/webhook.service.js";

export async function createSubscriptionController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = await getUserId(req);
    const { workflow_id, node_id, integration_key, event_key, config, poll_interval } =
      req.body;

    if (!workflow_id || !node_id || !integration_key || !event_key) {
      const missing = [
        !workflow_id && "workflow_id",
        !node_id && "node_id",
        !integration_key && "integration_key",
        !event_key && "event_key",
      ].filter(Boolean);
      return ApiResponse(res, 400, `Missing required fields: ${missing.join(", ")}`);
    }

    // ─── Hybrid dispatch ───────────────────────────────────────────────────
    if (supportsWebhook(integration_key)) {
      try {
        const subscription = await createWebhookSubscription({
          workflow_id,
          node_id,
          user_id: userId,
          integration_key,
          event_key,
          config,
        });
        return ApiResponse(res, 201, "Webhook subscription created", {
          ...subscription,
          _delivery_mode: "webhook",
        });
      } catch (err: any) {
        // Adapter chose to opt out (e.g. Commusoft without partner registration).
        // Fall through to polling so the workflow still works.
        console.warn(
          `[SubscriptionController] webhook subscribe failed for ${integration_key}/${event_key} — falling back to polling. Reason: ${err?.message}`
        );
      }
    }

    const subscription = await createPollingSubscription({
      workflow_id,
      node_id,
      user_id: userId,
      integration_key,
      event_key,
      config,
      poll_interval,
    });

    ApiResponse(res, 201, "Polling subscription created", {
      ...subscription,
      _delivery_mode: "polling",
    });
  } catch (error) {
    next(error);
  }
}

export async function getSubscriptionByNodeController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const nodeId = req.params.nodeId;
    validateId(nodeId);

    // Webhook subscription has priority — that's the real delivery mechanism
    const webhookSub = await getWebhookSubscriptionByNodeId(nodeId);
    if (webhookSub) {
      return ApiResponse(res, 200, "Subscription retrieved", {
        ...webhookSub,
        _delivery_mode: "webhook",
      });
    }

    const subscription = await getSubscriptionByNodeId(nodeId);
    ApiResponse(res, 200, "Subscription retrieved", subscription
      ? { ...subscription, _delivery_mode: "polling" }
      : null);
  } catch (error) {
    next(error);
  }
}

export async function updateSubscriptionController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id;
    validateId(id);

    const { config, poll_interval, event_key, is_active } = req.body;

    // Webhook subscription? Only is_active is supported via this path; config
    // and event_key changes require a fresh subscribe (handled by frontend
    // calling createSubscription again, which is idempotent on node_id).
    const webhookSub = await getWebhookSubscriptionById(id);
    if (webhookSub) {
      if (typeof is_active === "boolean") {
        const updated = await setWebhookSubscriptionActive(id, is_active);
        return ApiResponse(res, 200, "Webhook subscription updated", {
          ...updated,
          _delivery_mode: "webhook",
        });
      }
      // Other field updates intentionally no-op for webhook subscriptions —
      // re-create instead via the create endpoint (idempotent on node_id).
      return ApiResponse(res, 200, "No-op for webhook subscription", {
        ...webhookSub,
        _delivery_mode: "webhook",
      });
    }

    const subscription = await updatePollingSubscription(id, {
      config,
      poll_interval,
      event_key,
      is_active,
    });

    ApiResponse(res, 200, "Subscription updated", {
      ...subscription,
      _delivery_mode: "polling",
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteSubscriptionController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id;
    validateId(id);

    const webhookSub = await getWebhookSubscriptionById(id);
    if (webhookSub) {
      const result = await deleteWebhookSubscription(id);
      return ApiResponse(res, 200, result.message);
    }

    const result = await deletePollingSubscription(id);
    ApiResponse(res, 200, result.message);
  } catch (error) {
    next(error);
  }
}

export async function pollNowController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id;
    validateId(id);

    console.log(`[PollNow] ▶ manual trigger received  sub=${id}`);
    const startedAt = Date.now();

    // Test step — webhook subs delegate to polling adapter's fetchSample
    // since vendors don't expose historical events via webhooks.
    const webhookSub = await getWebhookSubscriptionById(id);
    if (webhookSub) {
      const result = await pollNowForWebhookSubscription(id);
      const duration = Date.now() - startedAt;
      console.log(
        `[PollNow] ◀ complete (webhook sub)  sub=${id}  found=${result.found}  duration=${duration}ms`
      );
      return ApiResponse(
        res,
        200,
        result.found ? "Sample record found" : "No records found",
        result
      );
    }

    const result = await pollNowService(id);

    const duration = Date.now() - startedAt;
    console.log(
      `[PollNow] ◀ complete  sub=${id}  found=${result.found}  duration=${duration}ms`
    );

    ApiResponse(res, 200, result.found ? "Sample record found" : "No records found", result);
  } catch (error: any) {
    console.error(`[PollNow] ✖ failed  sub=${req.params.id}  error=${error?.message}`);
    next(error);
  }
}

export async function getSubscriptionStatusController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id;
    validateId(id);

    const webhookSub = await getWebhookSubscriptionById(id);
    if (webhookSub) {
      const status = await getWebhookSubscriptionStatus(id);
      return ApiResponse(res, 200, "Subscription status retrieved", status);
    }

    const status = await getSubscriptionStatus(id);
    ApiResponse(res, 200, "Subscription status retrieved", {
      ...status,
      delivery_mode: "polling",
    });
  } catch (error) {
    next(error);
  }
}
