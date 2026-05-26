import { Request, Response } from "express";
import { GoogleSheetsService, TriggerType } from "../service/googleSheets.service.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { getUserId } from "../../../../common/function.js";

const VALID_TRIGGER_TYPES: TriggerType[] = [
  "new_row",
  "new_or_updated_row",
  "new_spreadsheet",
  "new_worksheet",
];

export class GoogleSheetsController {

  // ── OAuth ────────────────────────────────────────────────────────────────────

  static getConnectUrl = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const url = GoogleSheetsService.getConnectUrl(userId);
    return ApiResponse(res, 200, "Google Sheets auth URL generated", { url });
  };

  static handleCallback = async (req: Request, res: Response) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) throw new ApiError(400, `Google OAuth error: ${oauthError}`);
    if (!code)  throw new ApiError(400, "No authorization code received");
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

    await GoogleSheetsService.exchangeCodeForTokens(userId, String(code));

    return res.send(`<!DOCTYPE html><html><body>
      <script>window.close();</script>
      <p>Google Sheets connected successfully. You may close this window.</p>
      </body></html>`);
  };

  static connectionStatus = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await GoogleSheetsService.getConnectionStatus(userId);
    return ApiResponse(res, 200, "Status fetched", data);
  };

  static disconnect = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await GoogleSheetsService.disconnect(userId);
    return ApiResponse(res, 200, "Google Sheets disconnected successfully", data);
  };

  // ── Triggers ─────────────────────────────────────────────────────────────────

  // Trigger: New Spreadsheet
  static listSpreadsheets = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await GoogleSheetsService.listSpreadsheets(userId);
    return ApiResponse(res, 200, "Spreadsheets fetched", data);
  };

  // Trigger: New Worksheet
  static listWorksheets = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const spreadsheetId = String(req.params.spreadsheetId);
    const data = await GoogleSheetsService.listWorksheets(userId, spreadsheetId);
    return ApiResponse(res, 200, "Worksheets fetched", data);
  };

  // Trigger: New Spreadsheet Row
  static getNewRows = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const spreadsheetId = String(req.params.spreadsheetId);
    const sheetName = String(req.query.sheet_name ?? "Sheet1");
    const data = await GoogleSheetsService.getNewRows(userId, spreadsheetId, sheetName);
    return ApiResponse(res, 200, "New rows fetched", data);
  };

  // Trigger: New or Updated Spreadsheet Row
  static getUpdatedRows = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const spreadsheetId = String(req.params.spreadsheetId);
    const sheetName = String(req.query.sheet_name ?? "Sheet1");
    const data = await GoogleSheetsService.getUpdatedRows(userId, spreadsheetId, sheetName);
    return ApiResponse(res, 200, "Changed rows fetched", data);
  };

  // ── Actions ───────────────────────────────────────────────────────────────────

  // Action: Get Rows
  static getRows = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const spreadsheetId = String(req.params.spreadsheetId);
    const sheetName = String(req.query.sheet_name ?? "Sheet1");
    const range     = req.query.range ? String(req.query.range) : undefined;
    const data = await GoogleSheetsService.getRows(userId, spreadsheetId, sheetName, range);
    return ApiResponse(res, 200, "Rows fetched", data);
  };

  // Action: Append Row
  static appendRow = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const spreadsheetId = String(req.params.spreadsheetId);
    const { sheet_name = "Sheet1", row_data } = req.body;
    if (!row_data || typeof row_data !== "object") {
      throw new ApiError(400, "row_data object is required");
    }
    const data = await GoogleSheetsService.appendRow(userId, spreadsheetId, sheet_name, row_data);
    return ApiResponse(res, 201, "Row appended", data);
  };

  // Action: Update Row
  static updateRow = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const spreadsheetId = String(req.params.spreadsheetId);
    const rowNumber     = parseInt(String(req.params.rowNumber), 10);
    const { sheet_name = "Sheet1", row_data } = req.body;
    if (isNaN(rowNumber) || rowNumber < 2) {
      throw new ApiError(400, "row_number must be a number >= 2 (row 1 is the header)");
    }
    if (!row_data || typeof row_data !== "object") {
      throw new ApiError(400, "row_data object is required");
    }
    const data = await GoogleSheetsService.updateRow(userId, spreadsheetId, sheet_name, rowNumber, row_data);
    return ApiResponse(res, 200, "Row updated", data);
  };

  // Action: Look Up Row
  static lookupRow = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const spreadsheetId = String(req.params.spreadsheetId);
    const { sheet_name = "Sheet1", column_name, search_value } = req.body;
    if (!column_name) throw new ApiError(400, "column_name is required");
    if (search_value === undefined) throw new ApiError(400, "search_value is required");
    const data = await GoogleSheetsService.lookupRow(
      userId, spreadsheetId, sheet_name, column_name, String(search_value)
    );
    return ApiResponse(res, 200, "Lookup complete", data);
  };

  // Action: Delete Row
  static deleteRow = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const spreadsheetId = String(req.params.spreadsheetId);
    const rowNumber     = parseInt(String(req.params.rowNumber), 10);
    const sheetName     = String(req.query.sheet_name ?? "Sheet1");
    if (isNaN(rowNumber) || rowNumber < 2) {
      throw new ApiError(400, "row_number must be >= 2");
    }
    const data = await GoogleSheetsService.deleteRow(userId, spreadsheetId, sheetName, rowNumber);
    return ApiResponse(res, 200, "Row deleted", data);
  };

  // Action: Clear Row
  static clearRow = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const spreadsheetId = String(req.params.spreadsheetId);
    const rowNumber     = parseInt(String(req.params.rowNumber), 10);
    const sheetName     = String(req.query.sheet_name ?? "Sheet1");
    if (isNaN(rowNumber) || rowNumber < 2) {
      throw new ApiError(400, "row_number must be >= 2");
    }
    const data = await GoogleSheetsService.clearRow(userId, spreadsheetId, sheetName, rowNumber);
    return ApiResponse(res, 200, "Row cleared", data);
  };

  // Action: Create Spreadsheet
  static createSpreadsheet = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { title, sheet_names } = req.body;
    if (!title) throw new ApiError(400, "title is required");
    const data = Array.isArray(sheet_names)
      ? await GoogleSheetsService.createSpreadsheet(userId, title, sheet_names)
      : await GoogleSheetsService.createSpreadsheet(userId, title);
    return ApiResponse(res, 201, "Spreadsheet created", data);
  };

  // Action: Create Worksheet
  static createWorksheet = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const spreadsheetId = String(req.params.spreadsheetId);
    const { sheet_title } = req.body;
    if (!sheet_title) throw new ApiError(400, "sheet_title is required");
    const data = await GoogleSheetsService.createWorksheet(userId, spreadsheetId, sheet_title);
    return ApiResponse(res, 201, "Worksheet created", data);
  };

  // ── Watch management ──────────────────────────────────────────────────────────

  static createWatch = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { spreadsheet_id, sheet_name = "Sheet1", trigger_type } = req.body;
    if (!spreadsheet_id) throw new ApiError(400, "spreadsheet_id is required");
    if (!VALID_TRIGGER_TYPES.includes(trigger_type)) {
      throw new ApiError(
        400,
        `trigger_type must be one of: ${VALID_TRIGGER_TYPES.join(", ")}`
      );
    }
    const data = await GoogleSheetsService.createWatch(
      userId, spreadsheet_id, sheet_name, trigger_type
    );
    return ApiResponse(res, 201, "Watch created", data);
  };

  static deleteWatch = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const { spreadsheet_id, sheet_name = "Sheet1", trigger_type } = req.body;
    if (!spreadsheet_id || !trigger_type) {
      throw new ApiError(400, "spreadsheet_id and trigger_type are required");
    }
    const data = await GoogleSheetsService.deleteWatch(
      userId, spreadsheet_id, sheet_name, trigger_type
    );
    return ApiResponse(res, 200, "Watch removed", data);
  };

  static listWatches = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await GoogleSheetsService.listWatches(userId);
    return ApiResponse(res, 200, "Watches fetched", data);
  };

  static syncAllWatches = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await GoogleSheetsService.syncAllWatches(userId);
    return ApiResponse(res, 200, "Sync complete", data);
  };

  // ── DB reads ──────────────────────────────────────────────────────────────────

  static getSpreadsheetsFromDb = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await GoogleSheetsService.getSpreadsheetsFromDb(userId);
    return ApiResponse(res, 200, "Spreadsheets fetched from DB", data);
  };

  static getCachedRows = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const spreadsheetId = String(req.params.spreadsheetId);
    const sheetName = req.query.sheet_name ? String(req.query.sheet_name) : undefined;
    const data = await GoogleSheetsService.getCachedRows(userId, spreadsheetId, sheetName);
    return ApiResponse(res, 200, "Cached rows fetched", data);
  };
}
