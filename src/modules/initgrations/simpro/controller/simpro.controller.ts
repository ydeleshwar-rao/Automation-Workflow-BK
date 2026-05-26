import { Request, Response } from "express";
import { SimproService } from "../service/simpro.service.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { getUserId } from "../../../../common/function.js";

export class SimproController {
  // ─── OAuth ───────────────────────────────────────────────────────────
  static getConnectUrl = async (req: Request, res: Response) => {
    const userId    = await getUserId(req);
    const buildName = String(req.query.build_name || "").trim();

    const clientId    = process.env.SIMPRO_CLIENT_ID;
    const redirectUri = process.env.SIMPRO_REDIRECT_URI;
    const scopes      = process.env.SIMPRO_SCOPE || "";

    if (!clientId || !redirectUri) {
      throw new ApiError(500, "Simpro client config missing (SIMPRO_CLIENT_ID / SIMPRO_REDIRECT_URI)");
    }
    if (!buildName) {
      throw new ApiError(400, "build_name query param required (the tenant subdomain, e.g. 'acme' for acme.simprosuite.com)");
    }

    const statePayload = Buffer.from(JSON.stringify({ userId, buildName })).toString("base64url");

    const params = new URLSearchParams({
      response_type: "code",
      client_id:     clientId,
      redirect_uri:  redirectUri,
      state:         statePayload,
    });
    if (scopes) params.set("scope", scopes);

    const url = `https://${buildName}.simprosuite.com/oauth2/authorize?${params.toString()}`;
    return ApiResponse(res, 200, "Auth URL generated", { url });
  };

  static handleCallback = async (req: Request, res: Response) => {
    const { code, state } = req.query;
    if (!code)  throw new ApiError(400, "No authorization code");
    if (!state) throw new ApiError(400, "State missing");

    let userId: string;
    let buildName: string;
    try {
      const decoded = JSON.parse(Buffer.from(String(state), "base64url").toString("utf8"));
      userId    = decoded.userId;
      buildName = decoded.buildName;
    } catch {
      throw new ApiError(400, "Invalid state parameter");
    }
    if (!userId || !buildName) {
      throw new ApiError(400, "User ID or build name missing in state");
    }

    const redirectUri = process.env.SIMPRO_REDIRECT_URI!;
    const result = await SimproService.exchangeCodeForTokens(
      userId,
      buildName,
      String(code),
      redirectUri
    );

    void result;
    return res.send(
      `<!DOCTYPE html><html><body><script>window.close();</script>` +
      `<p>Connected to Simpro build <b>${buildName}</b>. You may close this window.</p>` +
      `</body></html>`
    );
  };

  // ─── API Key connect ─────────────────────────────────────────────────
  static connectWithApiKey = async (req: Request, res: Response) => {
    const userId   = await getUserId(req);
    const { build_name, api_key } = req.body || {};

    if (!build_name || typeof build_name !== "string" || !build_name.trim()) {
      throw new ApiError(400, "build_name is required (e.g. 'lucasandson')");
    }
    if (!api_key || typeof api_key !== "string" || !api_key.trim()) {
      throw new ApiError(400, "api_key is required (copy from the downloaded .txt file)");
    }

    const data = await SimproService.connectWithApiKey(
      userId,
      build_name.trim(),
      api_key.trim()
    );
    return ApiResponse(res, 200, "Simpro connected via API key", data);
  };

  static connectionStatus = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data   = await SimproService.getConnectionStatus(userId);
    return ApiResponse(res, 200, "Status fetched", data);
  };

  static disconnect = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data   = await SimproService.disconnect(userId);
    return ApiResponse(res, 200, "Simpro disconnected successfully", data);
  };

  /**
   * POST /simpro/sync — master sync (all resources in dependency order)
   *
   * HTTP semantics (ServiceM8 pattern):
   *   - 200: success or partial (at least one resource synced)
   *   - 500: all resources failed
   */
  static syncAll = async (req: Request, res: Response) => {
    try {
      const userId = await getUserId(req);
      const result = await SimproService.syncAll(userId);

      const statusCode = result.overall === "failed" ? 500 : 200;

      const message =
        result.overall === "success"
          ? "Full sync completed successfully"
          : result.overall === "partial"
            ? `Partial sync — failed: ${result.failedEntities.join(", ")}`
            : "Sync failed for all resources";

      return res.status(statusCode).json({
        success: result.overall !== "failed",
        message,
        data: result,
      });
    } catch (error: any) {
      console.error("[Controller] simPRO syncAll catastrophic error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to execute master sync",
      });
    }
  };

  // ─── DB reads (populate via POST /simpro/sync) ─────────────────────────

  static getCustomers = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await SimproService.getCustomers(userId);
    return ApiResponse(res, 200, "Customers fetched successfully", data);
  };

  static getJobs = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await SimproService.getJobs(userId);
    return ApiResponse(res, 200, "Jobs fetched successfully", data);
  };

  static getSites = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await SimproService.getSites(userId);
    return ApiResponse(res, 200, "Sites fetched successfully", data);
  };

  static getEmployees = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await SimproService.getEmployees(userId);
    return ApiResponse(res, 200, "Employees fetched successfully", data);
  };

  static getSchedules = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await SimproService.getSchedules(userId);
    return ApiResponse(res, 200, "Schedules fetched successfully", data);
  };

  /**
   * GET /simpro/getalljobs — UI dashboard feed (Commusoft-shape)
   *
   * Query params:
   *   - limit: number (default 50, max 200)
   *   - cursor: string (for pagination)
   *
   * Returns: Grouped by customer with full job details
   */
  static getAllJobs = async (req: Request, res: Response) => {
    try {
      const userId = await getUserId(req);
      const limit = Math.min(
        Math.max(parseInt(req.query.limit as string, 10) || 50, 1),
        200
      );
      const cursor = req.query.cursor as string | undefined;

      const data = await SimproService.getAllJobsCommusoftShape(
        userId,
        limit,
        cursor
      );

      return res.status(200).json({
        success: true,
        data: data.data,
        meta: data.meta,
      });
    } catch (error: any) {
      console.error("[Controller] simPRO getAllJobs failed:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch jobs",
      });
    }
  };
}
