import { Request, Response } from "express";
import { ZohoFormsService } from "../service/zohoForms.service.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { getUserId } from "../../../../common/function.js";

const getParam = (value: string | string[] | undefined, name: string): string => {
  if (!value || Array.isArray(value)) throw new ApiError(400, `${name} param is required`);
  return value;
};

export class ZohoFormsController {
  // ─── OAuth ────────────────────────────────────────────────────────────

  static getConnectUrl = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const url = ZohoFormsService.getConnectUrl(userId);
    return ApiResponse(res, 200, "Zoho Forms auth URL generated", { url });
  };

  static handleCallback = async (req: Request, res: Response) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) throw new ApiError(400, `Zoho OAuth error: ${oauthError}`);
    if (!code) throw new ApiError(400, "No authorization code received");
    if (!state) throw new ApiError(400, "State missing");

    let userId: string;
    try {
      const decoded = JSON.parse(
        Buffer.from(String(state), "base64url").toString("utf8")
      );
      userId = decoded.userId;
    } catch {
      throw new ApiError(400, "Invalid state parameter");
    }
    if (!userId) throw new ApiError(400, "User ID missing in state");

    await ZohoFormsService.exchangeCodeForTokens(userId, String(code));

    return res.send(
      `<!DOCTYPE html><html><body>
       <script>window.close();</script>
       <p>Zoho Forms connected successfully. You may close this window.</p>
       </body></html>`
    );
  };

  static connectionStatus = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoFormsService.getConnectionStatus(userId);
    return ApiResponse(res, 200, "Status fetched", data);
  };

  static disconnect = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoFormsService.disconnect(userId);
    return ApiResponse(res, 200, "Zoho Forms disconnected successfully", data);
  };

  // ─── Forms ────────────────────────────────────────────────────────────

  static listForms = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoFormsService.listForms(userId);
    return ApiResponse(res, 200, "Forms fetched from Zoho", data);
  };

  static getFormsFromDb = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoFormsService.getFormsFromDb(userId);
    return ApiResponse(res, 200, "Forms fetched from DB", data);
  };

  static getFormDetails = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const formId = getParam(req.params.formId, "formId");
    const data = await ZohoFormsService.getFormDetails(userId, formId);
    return ApiResponse(res, 200, "Form details fetched", data);
  };

  static getFormFields = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const formId = getParam(req.params.formId, "formId");
    const data = await ZohoFormsService.getFormFields(userId, formId);
    return ApiResponse(res, 200, "Form fields fetched", data);
  };

  // ─── Submissions ──────────────────────────────────────────────────────

  static getSubmissions = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const formId = getParam(req.params.formId, "formId");
    const page = parseInt(String(req.query.page ?? "1"), 10);
    const perPage = Math.min(parseInt(String(req.query.per_page ?? "100"), 10), 200);
    const data = await ZohoFormsService.getSubmissions(userId, formId, page, perPage);
    return ApiResponse(res, 200, "Submissions fetched from Zoho", data);
  };

  static getSubmissionsFromDb = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const formId = req.query.form_id as string | undefined;
    const data = await ZohoFormsService.getSubmissionsFromDb(userId, formId);
    return ApiResponse(res, 200, "Submissions fetched from DB", data);
  };

  static syncAllSubmissions = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoFormsService.syncAllSubmissions(userId);
    return ApiResponse(res, 200, "All submissions synced", data);
  };

  // ─── Webhooks ─────────────────────────────────────────────────────────

  static setupWebhook = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const formId = getParam(req.params.formId, "formId");
    const data = await ZohoFormsService.setupWebhook(userId, formId);
    return ApiResponse(res, 201, "Webhook registered on Zoho Forms", data);
  };

  static removeWebhook = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const formId = getParam(req.params.formId, "formId");
    const data = await ZohoFormsService.removeWebhook(userId, formId);
    return ApiResponse(res, 200, "Webhook removed", data);
  };

  static listWebhooks = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoFormsService.listWebhooks(userId);
    return ApiResponse(res, 200, "Webhooks fetched", data);
  };

  // ─── Incoming Webhook Receiver ────────────────────────────────────────
  // Zoho Forms posts here on every new submission (no auth middleware — public endpoint)

  static incomingWebhook = async (req: Request, res: Response) => {
    const { userId, formId } = req.params;

    if (!userId || !formId || Array.isArray(userId) || Array.isArray(formId)) {
      return res.status(400).json({ success: false, message: "userId and formId required" });
    }

    try {
      const result = await ZohoFormsService.handleIncomingSubmission(
        userId,
        formId,
        req.body ?? {}
      );
      return res.status(200).json({ success: true, ...result });
    } catch (err: any) {
      console.error(`[ZohoForms] Webhook handler error:`, err.message);
      // Always return 200 to Zoho so it doesn't retry
      return res.status(200).json({ success: false, message: err.message });
    }
  };
}
