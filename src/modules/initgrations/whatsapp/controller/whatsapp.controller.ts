import { Request, Response } from "express";
import { WhatsAppService } from "../service/whatsapp.service.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { getUserId } from "../../../../common/function.js";

export class WhatsAppController {

  // ── Connection ──────────────────────────────────────────────────────────────

  static connect = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await WhatsAppService.connect(userId);
    return ApiResponse(res, 200, "WhatsApp connection initiated", data);
  };

  static getQrCode = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await WhatsAppService.getQrCode(userId);
    return ApiResponse(res, 200, "QR code status", data);
  };

  static connectionStatus = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await WhatsAppService.getConnectionStatus(userId);
    return ApiResponse(res, 200, "Connection status fetched", data);
  };

  static disconnect = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await WhatsAppService.disconnect(userId);
    return ApiResponse(res, 200, "WhatsApp disconnected successfully", data);
  };

  // ── Webhook ─────────────────────────────────────────────────────────────────

  static setWebhook = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { webhook_url, webhook_secret } = req.body;
    if (!webhook_url) throw new ApiError(400, "webhook_url is required");
    const data = await WhatsAppService.setWebhook(userId, webhook_url, webhook_secret);
    return ApiResponse(res, 200, "Webhook configured successfully", data);
  };

  static getWebhook = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await WhatsAppService.getWebhook(userId);
    return ApiResponse(res, 200, "Webhook config fetched", data);
  };

  static removeWebhook = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await WhatsAppService.removeWebhook(userId);
    return ApiResponse(res, 200, "Webhook removed", data);
  };

  // ── Messages: Rich types ────────────────────────────────────────────────────

  static sendText = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { to, message } = req.body;
    if (!to) throw new ApiError(400, "to is required");
    if (!message) throw new ApiError(400, "message is required");
    const data = await WhatsAppService.sendText(userId, { to, message });
    return ApiResponse(res, 200, "Text message sent", data);
  };

  static sendImage = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { to, url, caption, mimetype } = req.body;
    if (!to || !url) throw new ApiError(400, "to and url are required");
    const data = await WhatsAppService.sendImage(userId, { to, type: "image", url, caption, mimetype });
    return ApiResponse(res, 200, "Image sent", data);
  };

  static sendVideo = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { to, url, caption, mimetype } = req.body;
    if (!to || !url) throw new ApiError(400, "to and url are required");
    const data = await WhatsAppService.sendVideo(userId, { to, type: "video", url, caption, mimetype });
    return ApiResponse(res, 200, "Video sent", data);
  };

  static sendAudio = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { to, url, mimetype } = req.body;
    if (!to || !url) throw new ApiError(400, "to and url are required");
    const data = await WhatsAppService.sendAudio(userId, { to, type: "audio", url, mimetype });
    return ApiResponse(res, 200, "Audio sent", data);
  };

  static sendVoiceNote = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { to, url, mimetype } = req.body;
    if (!to || !url) throw new ApiError(400, "to and url are required");
    const data = await WhatsAppService.sendVoiceNote(userId, { to, type: "audio", url, mimetype });
    return ApiResponse(res, 200, "Voice note sent", data);
  };

  static sendDocument = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { to, url, filename, caption, mimetype } = req.body;
    if (!to || !url) throw new ApiError(400, "to and url are required");
    const data = await WhatsAppService.sendDocument(userId, { to, type: "document", url, filename, caption, mimetype });
    return ApiResponse(res, 200, "Document sent", data);
  };

  static sendLocation = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { to, lat, lng, name, address } = req.body;
    if (!to || lat === undefined || lng === undefined) {
      throw new ApiError(400, "to, lat, lng are required");
    }
    const data = await WhatsAppService.sendLocation(userId, { to, lat, lng, name, address });
    return ApiResponse(res, 200, "Location sent", data);
  };

  static sendContact = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { to, name, phone, org } = req.body;
    if (!to || !name || !phone) throw new ApiError(400, "to, name, phone are required");
    const data = await WhatsAppService.sendContact(userId, { to, name, phone, org });
    return ApiResponse(res, 200, "Contact card sent", data);
  };

  // ── Messages: Interactive ───────────────────────────────────────────────────

  static sendButtons = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { to, text, footer, buttons } = req.body;
    if (!to || !text) throw new ApiError(400, "to and text are required");
    if (!Array.isArray(buttons) || !buttons.length) {
      throw new ApiError(400, "buttons array is required");
    }
    const data = await WhatsAppService.sendButtons(userId, { to, text, footer, buttons });
    return ApiResponse(res, 200, "Button message sent", data);
  };

  static sendList = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { to, text, footer, title, buttonText, sections } = req.body;
    if (!to || !text) throw new ApiError(400, "to and text are required");
    if (!Array.isArray(sections) || !sections.length) {
      throw new ApiError(400, "sections array is required");
    }
    const data = await WhatsAppService.sendList(userId, {
      to,
      text,
      footer,
      title: title ?? "",
      buttonText: buttonText ?? "Select",
      sections,
    });
    return ApiResponse(res, 200, "List message sent", data);
  };

  // ── Messages: Bulk ──────────────────────────────────────────────────────────

  static sendBulk = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) {
      throw new ApiError(400, "messages array is required");
    }
    const data = await WhatsAppService.sendBulk(userId, messages);
    return ApiResponse(res, 200, "Bulk messages processed", data);
  };

  // ── Groups ──────────────────────────────────────────────────────────────────

  static getGroups = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await WhatsAppService.getGroups(userId);
    return ApiResponse(res, 200, "Groups fetched", data);
  };

  static createGroup = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { name, participants } = req.body;
    if (!name) throw new ApiError(400, "name is required");
    if (!Array.isArray(participants) || !participants.length) {
      throw new ApiError(400, "participants array is required");
    }
    const data = await WhatsAppService.createGroup(userId, { name, participants });
    return ApiResponse(res, 201, "Group created", data);
  };

  static getGroupInfo = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const groupId = String(req.params.groupId);
    const data = await WhatsAppService.getGroupInfo(userId, groupId);
    return ApiResponse(res, 200, "Group info fetched", data);
  };

  static addGroupParticipants = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const groupId = String(req.params.groupId);
    const { participants } = req.body;
    if (!Array.isArray(participants) || !participants.length) {
      throw new ApiError(400, "participants array is required");
    }
    const data = await WhatsAppService.addGroupParticipants(userId, groupId, participants);
    return ApiResponse(res, 200, "Participants added to group", data);
  };

  static removeGroupParticipants = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const groupId = String(req.params.groupId);
    const { participants } = req.body;
    if (!Array.isArray(participants) || !participants.length) {
      throw new ApiError(400, "participants array is required");
    }
    const data = await WhatsAppService.removeGroupParticipants(userId, groupId, participants);
    return ApiResponse(res, 200, "Participants removed from group", data);
  };

  static promoteGroupParticipants = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const groupId = String(req.params.groupId);
    const { participants } = req.body;
    if (!Array.isArray(participants) || !participants.length) {
      throw new ApiError(400, "participants array is required");
    }
    const data = await WhatsAppService.promoteGroupParticipants(userId, groupId, participants);
    return ApiResponse(res, 200, "Participants promoted to admin", data);
  };

  static demoteGroupParticipants = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const groupId = String(req.params.groupId);
    const { participants } = req.body;
    if (!Array.isArray(participants) || !participants.length) {
      throw new ApiError(400, "participants array is required");
    }
    const data = await WhatsAppService.demoteGroupParticipants(userId, groupId, participants);
    return ApiResponse(res, 200, "Participants demoted", data);
  };

  static sendGroupMessage = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const groupId = String(req.params.groupId);
    const { message } = req.body;
    if (!message) throw new ApiError(400, "message is required");
    const data = await WhatsAppService.sendGroupMessage(userId, groupId, message);
    return ApiResponse(res, 200, "Group message sent", data);
  };

  static updateGroupSubject = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const groupId = String(req.params.groupId);
    const { subject } = req.body;
    if (!subject) throw new ApiError(400, "subject is required");
    const data = await WhatsAppService.updateGroupSubject(userId, groupId, subject);
    return ApiResponse(res, 200, "Group subject updated", data);
  };

  static updateGroupDescription = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const groupId = String(req.params.groupId);
    const { description } = req.body;
    const data = await WhatsAppService.updateGroupDescription(userId, groupId, description ?? "");
    return ApiResponse(res, 200, "Group description updated", data);
  };

  static leaveGroup = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const groupId = String(req.params.groupId);
    const data = await WhatsAppService.leaveGroup(userId, groupId);
    return ApiResponse(res, 200, "Left group", data);
  };

  static getGroupInviteLink = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const groupId = String(req.params.groupId);
    const data = await WhatsAppService.getGroupInviteLink(userId, groupId);
    return ApiResponse(res, 200, "Invite link fetched", data);
  };

  // ── Status / Story ──────────────────────────────────────────────────────────

  static sendTextStatus = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { text, background_color } = req.body;
    if (!text) throw new ApiError(400, "text is required");
    const data = await WhatsAppService.sendTextStatus(userId, text, background_color);
    return ApiResponse(res, 200, "Text status posted", data);
  };

  static sendImageStatus = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { image_url, caption } = req.body;
    if (!image_url) throw new ApiError(400, "image_url is required");
    const data = await WhatsAppService.sendImageStatus(userId, image_url, caption);
    return ApiResponse(res, 200, "Image status posted", data);
  };

  static sendVideoStatus = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { video_url, caption } = req.body;
    if (!video_url) throw new ApiError(400, "video_url is required");
    const data = await WhatsAppService.sendVideoStatus(userId, video_url, caption);
    return ApiResponse(res, 200, "Video status posted", data);
  };

  // ── Channels ────────────────────────────────────────────────────────────────

  static getChannels = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await WhatsAppService.getChannels(userId);
    return ApiResponse(res, 200, "Channels fetched", data);
  };

  static sendChannelMessage = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { channel_jid, message } = req.body;
    if (!channel_jid || !message) {
      throw new ApiError(400, "channel_jid and message are required");
    }
    const data = await WhatsAppService.sendChannelMessage(userId, channel_jid, message);
    return ApiResponse(res, 200, "Channel message sent", data);
  };

  // ── Profile / Utilities ─────────────────────────────────────────────────────

  static getProfilePicture = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const phone = String(req.params.phone);
    const data = await WhatsAppService.getProfilePicture(userId, phone);
    return ApiResponse(res, 200, "Profile picture fetched", data);
  };

  static checkNumberExists = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const phone = String(req.params.phone);
    const data = await WhatsAppService.checkNumberExists(userId, phone);
    return ApiResponse(res, 200, "Number check complete", data);
  };
}
