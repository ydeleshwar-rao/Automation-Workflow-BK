import { Request, Response } from "express";
import { ZohoService } from "../service/zoho.service.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { getUserId } from "../../../../common/function.js";

export class ZohoController {
  // ─── OAuth ────────────────────────────────────────────────────────────

  static getConnectUrl = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const url = ZohoService.getConnectUrl(userId);
    return ApiResponse(res, 200, "Zoho auth URL generated", { url });
  };

  static handleCallback = async (req: Request, res: Response) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) throw new ApiError(400, `Zoho OAuth error: ${oauthError}`);
    if (!code) throw new ApiError(400, "No authorization code received");
    if (!state) throw new ApiError(400, "State missing");

    let userId: string;
    try {
      const decoded = JSON.parse(Buffer.from(String(state), "base64url").toString("utf8"));
      userId = decoded.userId;
    } catch {
      throw new ApiError(400, "Invalid state parameter");
    }
    if (!userId) throw new ApiError(400, "User ID missing in state");

    await ZohoService.exchangeCodeForTokens(userId, String(code));

    return res.send(
      `<!DOCTYPE html><html><body>
       <script>window.close();</script>
       <p>Zoho Inventory connected successfully. You may close this window.</p>
       </body></html>`
    );
  };

  static connectionStatus = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoService.getConnectionStatus(userId);
    return ApiResponse(res, 200, "Status fetched", data);
  };

  static disconnect = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoService.disconnect(userId);
    return ApiResponse(res, 200, "Zoho Inventory disconnected successfully", data);
  };

  // ─── Sync ─────────────────────────────────────────────────────────────

  static syncAll = async (req: Request, res: Response) => {
    try {
      const userId = await getUserId(req);
      const result = await ZohoService.syncAll(userId);
      const statusCode = result.overall === "failed" ? 500 : 200;
      const message =
        result.overall === "success"
          ? "Full sync completed successfully"
          : result.overall === "partial"
          ? `Partial sync — failed: ${result.failedEntities.join(", ")}`
          : "Sync failed for all resources";

      return res.status(statusCode).json({ success: result.overall !== "failed", message, data: result });
    } catch (err: any) {
      return res.status(500).json({ success: false, message: err.message ?? "Sync failed" });
    }
  };

  static syncContacts = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoService.syncContacts(userId);
    return ApiResponse(res, 200, "Contacts synced", data);
  };

  static syncItems = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoService.syncItems(userId);
    return ApiResponse(res, 200, "Items synced", data);
  };

  static syncInvoices = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoService.syncInvoices(userId);
    return ApiResponse(res, 200, "Invoices synced", data);
  };

  static syncSalesorders = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoService.syncSalesorders(userId);
    return ApiResponse(res, 200, "Sales orders synced", data);
  };

  // ─── Triggers: Get from DB ────────────────────────────────────────────

  static getContacts = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoService.getContacts(userId);
    return ApiResponse(res, 200, "Contacts fetched successfully", data);
  };

  static getItems = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoService.getItems(userId);
    return ApiResponse(res, 200, "Items fetched successfully", data);
  };

  static getInvoices = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoService.getInvoices(userId);
    return ApiResponse(res, 200, "Invoices fetched successfully", data);
  };

  static getSalesorders = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await ZohoService.getSalesorders(userId);
    return ApiResponse(res, 200, "Sales orders fetched successfully", data);
  };

  // ─── Actions: Create in Zoho ──────────────────────────────────────────

  static createContact = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    if (!req.body?.contact_name) throw new ApiError(400, "contact_name is required");
    const data = await ZohoService.createContact(userId, req.body);
    return ApiResponse(res, 201, "Contact created in Zoho Inventory", data);
  };

  static createItem = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    if (!req.body?.name) throw new ApiError(400, "name is required");
    const data = await ZohoService.createItem(userId, req.body);
    return ApiResponse(res, 201, "Item created in Zoho Inventory", data);
  };

  static createInvoice = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    if (!req.body?.customer_id) throw new ApiError(400, "customer_id is required");
    const data = await ZohoService.createInvoice(userId, req.body);
    return ApiResponse(res, 201, "Invoice created in Zoho Inventory", data);
  };

  static createSalesorder = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    if (!req.body?.customer_id) throw new ApiError(400, "customer_id is required");
    const data = await ZohoService.createSalesorder(userId, req.body);
    return ApiResponse(res, 201, "Sales order created in Zoho Inventory", data);
  };
}
