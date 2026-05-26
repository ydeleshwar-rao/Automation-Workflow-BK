import axios, { AxiosInstance } from "axios";
import { supabase } from "../../../../config/db.config.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { refreshGoogleSheetsAccessToken } from "../utils/refreshAccessToken.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SHEETS_BASE       = "https://sheets.googleapis.com/v4";
const DRIVE_BASE        = "https://www.googleapis.com/drive/v3";
const GOOGLE_AUTH_URL   = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL  = "https://oauth2.googleapis.com/token";
const API_TIMEOUT_MS    = 30_000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

const refreshLocks = new Map<string, Promise<any>>();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GoogleSheetsIntegrationRow {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  needs_reauth: boolean;
}

export type TriggerType =
  | "new_row"
  | "new_or_updated_row"
  | "new_spreadsheet"
  | "new_worksheet";

// ─── Integration row helpers ──────────────────────────────────────────────────

const getIntegrationRaw = async (userId: string): Promise<GoogleSheetsIntegrationRow> => {
  const { data, error } = await supabase
    .from("google_sheets_integrations")
    .select("user_id, access_token, refresh_token, expires_at, needs_reauth")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new ApiError(
      404,
      "Google Sheets integration not found. Please connect your account first."
    );
  }
  return data as GoogleSheetsIntegrationRow;
};

export const getIntegration = async (
  userId: string,
  forceRefresh = false
): Promise<GoogleSheetsIntegrationRow> => {
  const row = await getIntegrationRaw(userId);

  if (row.needs_reauth) {
    throw new ApiError(401, "Google Sheets requires re-authentication. Please reconnect.");
  }

  const isExpiringSoon =
    new Date(row.expires_at).getTime() <= Date.now() + REFRESH_BUFFER_MS;

  if (!isExpiringSoon && !forceRefresh) return row;

  const lockKey = `googlesheets:refresh:${userId}`;
  if (refreshLocks.has(lockKey)) {
    await refreshLocks.get(lockKey);
    return await getIntegrationRaw(userId);
  }

  const refreshPromise = refreshGoogleSheetsAccessToken(userId, row.refresh_token)
    .then(() => getIntegrationRaw(userId))
    .finally(() => refreshLocks.delete(lockKey));

  refreshLocks.set(lockKey, refreshPromise);
  return await refreshPromise;
};

// ─── Axios clients ────────────────────────────────────────────────────────────

const getSheetsClient = (token: string): AxiosInstance =>
  axios.create({
    baseURL: SHEETS_BASE,
    timeout: API_TIMEOUT_MS,
    headers: { Authorization: `Bearer ${token}` },
  });

const getDriveClient = (token: string): AxiosInstance =>
  axios.create({
    baseURL: DRIVE_BASE,
    timeout: API_TIMEOUT_MS,
    headers: { Authorization: `Bearer ${token}` },
  });

// Auto-retry on 401 with token refresh
async function sheetsRequest<T>(
  userId: string,
  fn: (sheets: AxiosInstance, drive: AxiosInstance) => Promise<T>
): Promise<T> {
  let integration = await getIntegration(userId);
  let sheets = getSheetsClient(integration.access_token);
  let drive  = getDriveClient(integration.access_token);

  try {
    return await fn(sheets, drive);
  } catch (err: any) {
    if (err?.response?.status === 401) {
      console.warn(`[GoogleSheets] 401 for user=${userId} — forcing token refresh`);
      integration = await getIntegration(userId, true);
      sheets = getSheetsClient(integration.access_token);
      drive  = getDriveClient(integration.access_token);
      return await fn(sheets, drive);
    }
    throw err;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Converts A1 range rows array into array of key-value objects using header row
function rowsToObjects(
  headers: string[],
  rows: string[][]
): Array<Record<string, string>> {
  return rows.map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h || `column_${i + 1}`] = row[i] ?? "";
    });
    return obj;
  });
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class GoogleSheetsService {

  // ── OAuth ───────────────────────────────────────────────────────────────────

  static getConnectUrl(userId: string): string {
    const clientId    = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_SHEETS_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      throw new ApiError(
        500,
        "Google Sheets config missing (GOOGLE_CLIENT_ID / GOOGLE_SHEETS_REDIRECT_URI)"
      );
    }

    const params = new URLSearchParams({
      response_type: "code",
      client_id:     clientId,
      redirect_uri:  redirectUri,
      scope:         GOOGLE_SCOPES,
      access_type:   "offline",
      prompt:        "consent",
      state: Buffer.from(
        JSON.stringify({ userId, app: "google_sheets" })
      ).toString("base64url"),
    });

    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  static async exchangeCodeForTokens(userId: string, code: string): Promise<void> {
    const redirectUri = process.env.GOOGLE_SHEETS_REDIRECT_URI!;

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "authorization_code",
        client_id:     process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri:  redirectUri,
        code,
      }),
    });

    const body: any = await res.json();
    if (!res.ok || body.error) {
      throw new ApiError(400, `Google OAuth failed: ${body.error_description || body.error}`);
    }
    if (!body.refresh_token) {
      throw new ApiError(
        400,
        "Google did not return a refresh_token. Revoke access at myaccount.google.com/permissions and reconnect."
      );
    }

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + (body.expires_in || 3600));

    const { error } = await supabase.from("google_sheets_integrations").upsert({
      user_id:       userId,
      access_token:  body.access_token,
      refresh_token: body.refresh_token,
      expires_at:    expiresAt.toISOString(),
      needs_reauth:  false,
    });

    if (error) throw new ApiError(500, `Failed to save tokens: ${error.message}`);
    console.log(`[GoogleSheets] ✅ Connected user=${userId}`);
  }

  static async getConnectionStatus(userId: string) {
    const { data } = await supabase
      .from("google_sheets_integrations")
      .select("user_id, needs_reauth, expires_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (!data) return { connected: false };
    return {
      connected:    true,
      needs_reauth: data.needs_reauth,
      expires_at:   data.expires_at,
    };
  }

  static async disconnect(userId: string) {
    const { data: row } = await supabase
      .from("google_sheets_integrations")
      .select("access_token")
      .eq("user_id", userId)
      .maybeSingle();

    if (row?.access_token) {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${row.access_token}`,
        { method: "POST" }
      ).catch(() => {});
    }

    await Promise.allSettled([
      supabase.from("google_sheets_integrations").delete().eq("user_id", userId),
      supabase.from("google_sheets_list").delete().eq("user_id", userId),
      supabase.from("google_sheet_rows").delete().eq("user_id", userId),
      supabase.from("google_sheet_watches").delete().eq("user_id", userId),
    ]);

    return { disconnected: true };
  }

  // ── Triggers ─────────────────────────────────────────────────────────────────
  // (Zapier-style polling triggers)

  // ── Trigger: New Spreadsheet — polls Drive for newly created sheets ──────────

  static async listSpreadsheets(userId: string) {
    const spreadsheets: any[] = [];
    let pageToken: string | undefined;

    await sheetsRequest(userId, async (_, drive) => {
      do {
        const { data } = await drive.get("/files", {
          params: {
            q:         "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
            fields:    "nextPageToken, files(id, name, webViewLink, createdTime, modifiedTime)",
            orderBy:   "modifiedTime desc",
            pageSize:  100,
            ...(pageToken ? { pageToken } : {}),
          },
        });

        for (const f of data.files ?? []) {
          spreadsheets.push({
            spreadsheet_id: f.id,
            title:          f.name ?? "",
            url:            f.webViewLink ?? "",
            created_time:   f.createdTime ?? null,
            modified_time:  f.modifiedTime ?? null,
          });
        }

        pageToken = data.nextPageToken;
      } while (pageToken);
    });

    if (spreadsheets.length) {
      await supabase.from("google_sheets_list").upsert(
        spreadsheets.map((s) => ({ ...s, user_id: userId, google_id: s.spreadsheet_id })),
        { onConflict: "user_id,google_id" }
      );
    }

    return spreadsheets;
  }

  // ── Trigger: New Worksheet — polls a spreadsheet for new sheets/tabs ─────────

  static async listWorksheets(userId: string, spreadsheetId: string) {
    return sheetsRequest(userId, async (sheets) => {
      const { data } = await sheets.get(`/spreadsheets/${spreadsheetId}`, {
        params: { fields: "sheets(properties(sheetId,title,index,sheetType))" },
      });

      return (data.sheets ?? []).map((s: any) => ({
        sheet_id:   s.properties.sheetId,
        title:      s.properties.title,
        index:      s.properties.index,
        sheet_type: s.properties.sheetType,
      }));
    });
  }

  // ── Trigger: New Spreadsheet Row ─────────────────────────────────────────────
  // Returns rows added since the watch's last_row_count.

  static async getNewRows(
    userId: string,
    spreadsheetId: string,
    sheetName: string = "Sheet1"
  ) {
    return sheetsRequest(userId, async (sheets) => {
      const range = `${sheetName}!A1:ZZ`;
      const { data } = await sheets.get(
        `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
      );

      const allRows: string[][] = data.values ?? [];
      if (allRows.length < 2) return { headers: [], new_rows: [], total_rows: 0 };

      const headers = allRows[0]!.map(String);
      const dataRows = allRows.slice(1);

      // Fetch last known row count from watch
      const { data: watch } = await supabase
        .from("google_sheet_watches")
        .select("last_row_count")
        .eq("user_id", userId)
        .eq("spreadsheet_id", spreadsheetId)
        .eq("sheet_name", sheetName)
        .eq("trigger_type", "new_row")
        .maybeSingle();

      const lastCount = watch?.last_row_count ?? 0;
      const newDataRows = dataRows.slice(lastCount);
      const newRows = rowsToObjects(headers, newDataRows);

      // Update row count in watch
      if (newRows.length > 0) {
        await supabase
          .from("google_sheet_watches")
          .update({
            last_row_count: dataRows.length,
            last_synced_at: new Date().toISOString(),
          })
          .eq("user_id", userId)
          .eq("spreadsheet_id", spreadsheetId)
          .eq("sheet_name", sheetName)
          .eq("trigger_type", "new_row");
      }

      return { headers, new_rows: newRows, total_rows: dataRows.length };
    });
  }

  // ── Trigger: New or Updated Row ───────────────────────────────────────────────
  // Compares current data against cached snapshot and returns changed rows.

  static async getUpdatedRows(
    userId: string,
    spreadsheetId: string,
    sheetName: string = "Sheet1"
  ) {
    return sheetsRequest(userId, async (sheets) => {
      const range = `${sheetName}!A1:ZZ`;
      const { data } = await sheets.get(
        `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
      );

      const allRows: string[][] = data.values ?? [];
      if (allRows.length < 2) return { headers: [], changed_rows: [] };

      const headers = allRows[0]!.map(String);
      const dataRows = allRows.slice(1);
      const currentObjects = rowsToObjects(headers, dataRows);

      // Compare against cached rows
      const { data: cachedRows } = await supabase
        .from("google_sheet_rows")
        .select("row_number, row_data")
        .eq("user_id", userId)
        .eq("spreadsheet_id", spreadsheetId)
        .eq("sheet_name", sheetName)
        .order("row_number", { ascending: true });

      const cacheMap = new Map<number, Record<string, string>>(
        (cachedRows ?? []).map((r) => [r.row_number, r.row_data])
      );

      const changedRows: Array<{ row_number: number; data: Record<string, string> }> = [];

      for (let i = 0; i < currentObjects.length; i++) {
        const rowNum = i + 2; // row 1 is header
        const current = currentObjects[i];
        const cached  = cacheMap.get(rowNum);

        if (current && (!cached || JSON.stringify(current) !== JSON.stringify(cached))) {
          changedRows.push({ row_number: rowNum, data: current });
        }
      }

      // Upsert cache
      if (currentObjects.length > 0) {
        await supabase.from("google_sheet_rows").upsert(
          currentObjects.map((row, i) => ({
            user_id:        userId,
            spreadsheet_id: spreadsheetId,
            sheet_name:     sheetName,
            row_number:     i + 2,
            row_data:       row,
            updated_at:     new Date().toISOString(),
          })),
          { onConflict: "user_id,spreadsheet_id,sheet_name,row_number" }
        );

        await supabase
          .from("google_sheet_watches")
          .update({ last_synced_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("spreadsheet_id", spreadsheetId)
          .eq("sheet_name", sheetName)
          .eq("trigger_type", "new_or_updated_row");
      }

      return { headers, changed_rows: changedRows };
    });
  }

  // ── Actions ───────────────────────────────────────────────────────────────────
  // (Zapier-style actions that write back to Google Sheets)

  // ── Action: Get All Rows ──────────────────────────────────────────────────────

  static async getRows(
    userId: string,
    spreadsheetId: string,
    sheetName: string = "Sheet1",
    range?: string
  ) {
    return sheetsRequest(userId, async (sheets) => {
      const fullRange = range ?? `${sheetName}!A1:ZZ`;
      const { data } = await sheets.get(
        `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(fullRange)}`
      );

      const allRows: string[][] = data.values ?? [];
      if (!allRows.length) return { headers: [], rows: [], total: 0 };

      const headers = allRows[0]!.map(String);
      const rows = rowsToObjects(headers, allRows.slice(1));

      return { headers, rows, total: rows.length };
    });
  }

  // ── Action: Append Row ────────────────────────────────────────────────────────

  static async appendRow(
    userId: string,
    spreadsheetId: string,
    sheetName: string,
    rowData: Record<string, string>
  ) {
    return sheetsRequest(userId, async (sheets) => {
      // Get headers first to order values correctly
      const headerRange = `${sheetName}!1:1`;
      const { data: hData } = await sheets.get(
        `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(headerRange)}`
      );
      const headers: string[] = hData.values?.[0]?.map(String) ?? [];

      // Build row in header order; unknown keys appended at end
      const values = headers.length
        ? headers.map((h) => rowData[h] ?? "")
        : Object.values(rowData);

      const range = `${sheetName}!A:A`;
      const { data } = await sheets.post(
        `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append`,
        { values: [values] },
        { params: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" } }
      );

      return {
        updated_range:  data.updates?.updatedRange,
        updated_rows:   data.updates?.updatedRows,
        updated_cells:  data.updates?.updatedCells,
      };
    });
  }

  // ── Action: Update Row ────────────────────────────────────────────────────────

  static async updateRow(
    userId: string,
    spreadsheetId: string,
    sheetName: string,
    rowNumber: number,
    rowData: Record<string, string>
  ) {
    return sheetsRequest(userId, async (sheets) => {
      const headerRange = `${sheetName}!1:1`;
      const { data: hData } = await sheets.get(
        `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(headerRange)}`
      );
      const headers: string[] = hData.values?.[0]?.map(String) ?? [];

      const values = headers.length
        ? headers.map((h) => rowData[h] ?? "")
        : Object.values(rowData);

      const range = `${sheetName}!A${rowNumber}`;
      const { data } = await sheets.put(
        `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
        { values: [values] },
        { params: { valueInputOption: "USER_ENTERED" } }
      );

      return {
        updated_range: data.updatedRange,
        updated_rows:  data.updatedRows,
        updated_cells: data.updatedCells,
      };
    });
  }

  // ── Action: Look Up Row ───────────────────────────────────────────────────────

  static async lookupRow(
    userId: string,
    spreadsheetId: string,
    sheetName: string,
    columnName: string,
    searchValue: string
  ) {
    return sheetsRequest(userId, async (sheets) => {
      const range = `${sheetName}!A1:ZZ`;
      const { data } = await sheets.get(
        `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
      );

      const allRows: string[][] = data.values ?? [];
      if (allRows.length < 2) return { found: false, row: null };

      const headers = allRows[0]!.map(String);
      const colIndex = headers.indexOf(columnName);
      if (colIndex === -1) throw new ApiError(400, `Column "${columnName}" not found in sheet`);

      const dataRows = allRows.slice(1);
      const matchIndex = dataRows.findIndex(
        (row) => (row[colIndex] ?? "") === searchValue
      );

      if (matchIndex === -1) return { found: false, row: null };

      const matchedRow = dataRows[matchIndex];
      return {
        found:      true,
        row_number: matchIndex + 2,
        row:        matchedRow ? rowsToObjects(headers, [matchedRow])[0] ?? null : null,
      };
    });
  }

  // ── Action: Delete Row ────────────────────────────────────────────────────────

  static async deleteRow(
    userId: string,
    spreadsheetId: string,
    sheetName: string,
    rowNumber: number
  ) {
    return sheetsRequest(userId, async (sheets) => {
      // Get sheetId from name
      const { data: meta } = await sheets.get(`/spreadsheets/${spreadsheetId}`, {
        params: { fields: "sheets(properties(sheetId,title))" },
      });
      const sheet = (meta.sheets ?? []).find(
        (s: any) => s.properties.title === sheetName
      );
      if (!sheet) throw new ApiError(404, `Sheet "${sheetName}" not found`);

      const sheetId = sheet.properties.sheetId;
      const zeroIndex = rowNumber - 1;

      await sheets.post(`/spreadsheets/${spreadsheetId}:batchUpdate`, {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension:  "ROWS",
                startIndex: zeroIndex,
                endIndex:   zeroIndex + 1,
              },
            },
          },
        ],
      });

      return { deleted: true, row_number: rowNumber };
    });
  }

  // ── Action: Clear Row ─────────────────────────────────────────────────────────

  static async clearRow(
    userId: string,
    spreadsheetId: string,
    sheetName: string,
    rowNumber: number
  ) {
    return sheetsRequest(userId, async (sheets) => {
      const range = `${sheetName}!${rowNumber}:${rowNumber}`;
      await sheets.post(
        `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`
      );
      return { cleared: true, row_number: rowNumber };
    });
  }

  // ── Action: Create Spreadsheet ────────────────────────────────────────────────

  static async createSpreadsheet(
    userId: string,
    title: string,
    sheetNames: string[] = ["Sheet1"]
  ) {
    return sheetsRequest(userId, async (sheets) => {
      const { data } = await sheets.post("/spreadsheets", {
        properties: { title },
        sheets: sheetNames.map((name) => ({
          properties: { title: name },
        })),
      });

      return {
        spreadsheet_id: data.spreadsheetId,
        title:          data.properties?.title,
        url:            data.spreadsheetUrl,
        sheets:         (data.sheets ?? []).map((s: any) => ({
          sheet_id: s.properties.sheetId,
          title:    s.properties.title,
        })),
      };
    });
  }

  // ── Action: Create Worksheet (add a sheet/tab) ────────────────────────────────

  static async createWorksheet(
    userId: string,
    spreadsheetId: string,
    sheetTitle: string
  ) {
    return sheetsRequest(userId, async (sheets) => {
      const { data } = await sheets.post(`/spreadsheets/${spreadsheetId}:batchUpdate`, {
        requests: [{ addSheet: { properties: { title: sheetTitle } } }],
      });

      const addedSheet = data.replies?.[0]?.addSheet?.properties;
      return {
        sheet_id: addedSheet?.sheetId,
        title:    addedSheet?.title,
        index:    addedSheet?.index,
      };
    });
  }

  // ── Watch Management (polling subscriptions) ───────────────────────────────────

  static async createWatch(
    userId: string,
    spreadsheetId: string,
    sheetName: string,
    triggerType: TriggerType
  ) {
    const { error } = await supabase.from("google_sheet_watches").upsert(
      {
        user_id:        userId,
        spreadsheet_id: spreadsheetId,
        sheet_name:     sheetName,
        trigger_type:   triggerType,
        last_row_count: 0,
        last_synced_at: null,
        active:         true,
      },
      { onConflict: "user_id,spreadsheet_id,sheet_name,trigger_type" }
    );
    if (error) throw new ApiError(500, error.message);
    return { watched: true, spreadsheet_id: spreadsheetId, sheet_name: sheetName, trigger_type: triggerType };
  }

  static async deleteWatch(
    userId: string,
    spreadsheetId: string,
    sheetName: string,
    triggerType: TriggerType
  ) {
    await supabase
      .from("google_sheet_watches")
      .delete()
      .eq("user_id", userId)
      .eq("spreadsheet_id", spreadsheetId)
      .eq("sheet_name", sheetName)
      .eq("trigger_type", triggerType);
    return { unwatched: true };
  }

  static async listWatches(userId: string) {
    const { data, error } = await supabase
      .from("google_sheet_watches")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  // ── Sync: Poll all active watches (called by polling engine) ─────────────────

  static async syncAllWatches(userId: string) {
    const { data: watches } = await supabase
      .from("google_sheet_watches")
      .select("*")
      .eq("user_id", userId)
      .eq("active", true);

    if (!watches?.length) return { message: "No active watches", results: {} };

    const results: Record<string, any> = {};

    for (const w of watches) {
      const key = `${w.spreadsheet_id}:${w.sheet_name}:${w.trigger_type}`;
      try {
        if (w.trigger_type === "new_row") {
          const res = await GoogleSheetsService.getNewRows(userId, w.spreadsheet_id, w.sheet_name);
          results[key] = { new_rows: res.new_rows.length };
        } else if (w.trigger_type === "new_or_updated_row") {
          const res = await GoogleSheetsService.getUpdatedRows(userId, w.spreadsheet_id, w.sheet_name);
          results[key] = { changed_rows: res.changed_rows.length };
        } else if (w.trigger_type === "new_spreadsheet") {
          const sheets = await GoogleSheetsService.listSpreadsheets(userId);
          results[key] = { total_spreadsheets: sheets.length };
        } else if (w.trigger_type === "new_worksheet") {
          const tabs = await GoogleSheetsService.listWorksheets(userId, w.spreadsheet_id);
          results[key] = { total_worksheets: tabs.length };
        }
      } catch (err: any) {
        results[key] = { error: err.message };
      }
    }

    return results;
  }

  // ── DB reads ──────────────────────────────────────────────────────────────────

  static async getSpreadsheetsFromDb(userId: string) {
    const { data, error } = await supabase
      .from("google_sheets_list")
      .select("*")
      .eq("user_id", userId)
      .order("modified_time", { ascending: false });
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  static async getCachedRows(
    userId: string,
    spreadsheetId: string,
    sheetName?: string
  ) {
    let query = supabase
      .from("google_sheet_rows")
      .select("*")
      .eq("user_id", userId)
      .eq("spreadsheet_id", spreadsheetId)
      .order("row_number", { ascending: true });

    if (sheetName) query = query.eq("sheet_name", sheetName);

    const { data, error } = await query;
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }
}
