import { Router } from "express";
import { catchAsync } from "../../../../utils/catchAsync.js";
import { WhatsAppController } from "../controller/whatsapp.controller.js";

const router = Router();

// ─── Connection ───────────────────────────────────────────────────────────────
router.post("/connect",    catchAsync(WhatsAppController.connect));
router.get("/qr",          catchAsync(WhatsAppController.getQrCode));
router.get("/status",      catchAsync(WhatsAppController.connectionStatus));
router.delete("/disconnect", catchAsync(WhatsAppController.disconnect));

// ─── Webhook config ───────────────────────────────────────────────────────────
router.post("/webhook",    catchAsync(WhatsAppController.setWebhook));
router.get("/webhook",     catchAsync(WhatsAppController.getWebhook));
router.delete("/webhook",  catchAsync(WhatsAppController.removeWebhook));

// ─── Messages: Text ───────────────────────────────────────────────────────────
router.post("/messages/text",       catchAsync(WhatsAppController.sendText));

// ─── Messages: Rich media ─────────────────────────────────────────────────────
router.post("/messages/image",      catchAsync(WhatsAppController.sendImage));
router.post("/messages/video",      catchAsync(WhatsAppController.sendVideo));
router.post("/messages/audio",      catchAsync(WhatsAppController.sendAudio));
router.post("/messages/voice",      catchAsync(WhatsAppController.sendVoiceNote));
router.post("/messages/document",   catchAsync(WhatsAppController.sendDocument));
router.post("/messages/location",   catchAsync(WhatsAppController.sendLocation));
router.post("/messages/contact",    catchAsync(WhatsAppController.sendContact));

// ─── Messages: Interactive ────────────────────────────────────────────────────
router.post("/messages/buttons",    catchAsync(WhatsAppController.sendButtons));
router.post("/messages/list",       catchAsync(WhatsAppController.sendList));

// ─── Messages: Bulk ───────────────────────────────────────────────────────────
router.post("/messages/bulk",       catchAsync(WhatsAppController.sendBulk));

// ─── Groups ───────────────────────────────────────────────────────────────────
router.get("/groups",                              catchAsync(WhatsAppController.getGroups));
router.post("/groups",                             catchAsync(WhatsAppController.createGroup));
router.get("/groups/:groupId",                     catchAsync(WhatsAppController.getGroupInfo));
router.post("/groups/:groupId/message",            catchAsync(WhatsAppController.sendGroupMessage));
router.post("/groups/:groupId/participants/add",   catchAsync(WhatsAppController.addGroupParticipants));
router.post("/groups/:groupId/participants/remove",catchAsync(WhatsAppController.removeGroupParticipants));
router.post("/groups/:groupId/participants/promote",catchAsync(WhatsAppController.promoteGroupParticipants));
router.post("/groups/:groupId/participants/demote", catchAsync(WhatsAppController.demoteGroupParticipants));
router.patch("/groups/:groupId/subject",           catchAsync(WhatsAppController.updateGroupSubject));
router.patch("/groups/:groupId/description",       catchAsync(WhatsAppController.updateGroupDescription));
router.get("/groups/:groupId/invite",              catchAsync(WhatsAppController.getGroupInviteLink));
router.delete("/groups/:groupId/leave",            catchAsync(WhatsAppController.leaveGroup));

// ─── Status / Story ───────────────────────────────────────────────────────────
router.post("/status/text",    catchAsync(WhatsAppController.sendTextStatus));
router.post("/status/image",   catchAsync(WhatsAppController.sendImageStatus));
router.post("/status/video",   catchAsync(WhatsAppController.sendVideoStatus));

// ─── Channels ─────────────────────────────────────────────────────────────────
router.get("/channels",        catchAsync(WhatsAppController.getChannels));
router.post("/channels/send",  catchAsync(WhatsAppController.sendChannelMessage));

// ─── Utilities ────────────────────────────────────────────────────────────────
router.get("/profile/:phone",  catchAsync(WhatsAppController.getProfilePicture));
router.get("/check/:phone",    catchAsync(WhatsAppController.checkNumberExists));

export default router;
