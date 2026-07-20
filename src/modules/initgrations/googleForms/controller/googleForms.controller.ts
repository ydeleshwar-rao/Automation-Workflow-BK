import { Request, Response } from "express";
import { GoogleFormsService } from "../service/googleForms.service.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { getUserId } from "../../../../common/function.js";

const getParam = (value: string | string[] | undefined, name: string): string => {
  if (!value || Array.isArray(value)) throw new ApiError(400, `${name} param is required`);
  return value;
};

export class GoogleFormsController {
  // ─── OAuth ────────────────────────────────────────────────────────────

  static getConnectUrl = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const url = GoogleFormsService.getConnectUrl(userId);
    return ApiResponse(res, 200, "Google Forms auth URL generated", { url });
  };

  static handleCallback = async (req: Request, res: Response) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) throw new ApiError(400, `Google OAuth error: ${oauthError}`);
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

    await GoogleFormsService.exchangeCodeForTokens(userId, String(code));

    return res.send(
      `<!DOCTYPE html><html><body>
       <script>window.close();</script>
       <p>Google Forms connected successfully. You may close this window.</p>
       </body></html>`
    );
  };

  static connectionStatus = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await GoogleFormsService.getConnectionStatus(userId);
    return ApiResponse(res, 200, "Status fetched", data);
  };

  static disconnect = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await GoogleFormsService.disconnect(userId);
    return ApiResponse(res, 200, "Google Forms disconnected", data);
  };

  // ─── Forms ────────────────────────────────────────────────────────────

  static listForms = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await GoogleFormsService.listForms(userId);
    return ApiResponse(res, 200, "Forms fetched from Google Drive", data);
  };

  static getFormsFromDb = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await GoogleFormsService.getFormsFromDb(userId);
    return ApiResponse(res, 200, "Forms fetched from DB", data);
  };

  static getFormDetails = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const formId = getParam(req.params.formId, "formId");
    const data = await GoogleFormsService.getFormDetails(userId, formId);
    return ApiResponse(res, 200, "Form details fetched", data);
  };

  // ─── Responses ────────────────────────────────────────────────────────

  static getResponses = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const formId = getParam(req.params.formId, "formId");
    const since = req.query.since as string | undefined;
    const data = await GoogleFormsService.getResponses(userId, formId, since);
    return ApiResponse(res, 200, "Responses fetched from Google", data);
  };

  static getResponsesFromDb = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const formId = req.query.form_id as string | undefined;
    const data = await GoogleFormsService.getResponsesFromDb(userId, formId);
    return ApiResponse(res, 200, "Responses fetched from DB", data);
  };

  // ─── Sync (Trigger: New Form Response / New or Updated Form Response) ──

  static syncNewResponses = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await GoogleFormsService.syncNewResponses(userId);
    return ApiResponse(res, 200, "New responses synced from all watched forms", data);
  };

  // ─── Watch Management ─────────────────────────────────────────────────

  static watchForm = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const formId = getParam(req.params.formId, "formId");
    const data = await GoogleFormsService.watchForm(userId, formId);
    return ApiResponse(res, 201, "Form watch registered", data);
  };

  static unwatchForm = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const formId = getParam(req.params.formId, "formId");
    const data = await GoogleFormsService.unwatchForm(userId, formId);
    return ApiResponse(res, 200, "Form watch removed", data);
  };

  static listWatches = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await GoogleFormsService.listWatches(userId);
    return ApiResponse(res, 200, "Watched forms fetched", data);
  };
}
