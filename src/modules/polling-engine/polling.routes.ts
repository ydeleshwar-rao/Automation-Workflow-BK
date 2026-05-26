import { Router } from "express";
import {
  createSubscriptionController,
  getSubscriptionByNodeController,
  updateSubscriptionController,
  deleteSubscriptionController,
  pollNowController,
  getSubscriptionStatusController,
} from "./polling.controller.js";

const pollingRouter = Router();

// CRUD for polling subscriptions
pollingRouter.post("/subscriptions", createSubscriptionController);
pollingRouter.get("/subscriptions/by-node/:nodeId", getSubscriptionByNodeController);
pollingRouter.patch("/subscriptions/:id", updateSubscriptionController);
pollingRouter.delete("/subscriptions/:id", deleteSubscriptionController);

// Manual poll (for Test step in workflow builder)
pollingRouter.post("/subscriptions/:id/poll-now", pollNowController);

// Subscription health/status
pollingRouter.get("/subscriptions/:id/status", getSubscriptionStatusController);

export default pollingRouter;
