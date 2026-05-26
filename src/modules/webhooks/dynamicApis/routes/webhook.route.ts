import Router from "express";
import { handleCreateWebhook,handleIncomingWebhook, handleUpdateWebhook,handleGetWebhookById } from "../controllers/webhook.controller.js"
const router = Router();

router.post("/webhooks",handleCreateWebhook)
router.patch("/webhooks/update/:id", handleUpdateWebhook);
router.get("/getwebhook/:webhookId/event", handleGetWebhookById)
router.all("/webhooks/:hookPath",handleIncomingWebhook);

export default router;