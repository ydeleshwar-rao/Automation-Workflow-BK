import { Router } from "express";
import { catchAsync } from "../../../../utils/catchAsync.js";
import { GoogleSheetsController } from "../controller/googleSheets.controller.js";

const router = Router();

// ─── OAuth ────────────────────────────────────────────────────────────────────
router.get("/connect",    catchAsync(GoogleSheetsController.getConnectUrl));
router.get("/callback",   catchAsync(GoogleSheetsController.handleCallback));
router.get("/status",     catchAsync(GoogleSheetsController.connectionStatus));
router.delete("/disconnect", catchAsync(GoogleSheetsController.disconnect));

// ─── Triggers: New Spreadsheet ────────────────────────────────────────────────
router.get("/spreadsheets",        catchAsync(GoogleSheetsController.listSpreadsheets));
router.get("/spreadsheets/cached", catchAsync(GoogleSheetsController.getSpreadsheetsFromDb));

// ─── Triggers: New Worksheet ──────────────────────────────────────────────────
router.get(
  "/spreadsheets/:spreadsheetId/worksheets",
  catchAsync(GoogleSheetsController.listWorksheets)
);

// ─── Triggers: New Spreadsheet Row ────────────────────────────────────────────
// GET ?sheet_name=Sheet1
router.get(
  "/spreadsheets/:spreadsheetId/rows/new",
  catchAsync(GoogleSheetsController.getNewRows)
);

// ─── Triggers: New or Updated Spreadsheet Row ─────────────────────────────────
// GET ?sheet_name=Sheet1
router.get(
  "/spreadsheets/:spreadsheetId/rows/updated",
  catchAsync(GoogleSheetsController.getUpdatedRows)
);

// ─── Actions: Read Rows ───────────────────────────────────────────────────────
// GET ?sheet_name=Sheet1&range=A1:D50 (range optional)
router.get(
  "/spreadsheets/:spreadsheetId/rows",
  catchAsync(GoogleSheetsController.getRows)
);

// Cached rows from Supabase
router.get(
  "/spreadsheets/:spreadsheetId/rows/cached",
  catchAsync(GoogleSheetsController.getCachedRows)
);

// ─── Actions: Write Rows ──────────────────────────────────────────────────────
router.post(
  "/spreadsheets/:spreadsheetId/rows",
  catchAsync(GoogleSheetsController.appendRow)
);

router.put(
  "/spreadsheets/:spreadsheetId/rows/:rowNumber",
  catchAsync(GoogleSheetsController.updateRow)
);

router.post(
  "/spreadsheets/:spreadsheetId/rows/lookup",
  catchAsync(GoogleSheetsController.lookupRow)
);

// DELETE ?sheet_name=Sheet1
router.delete(
  "/spreadsheets/:spreadsheetId/rows/:rowNumber",
  catchAsync(GoogleSheetsController.deleteRow)
);

// POST (clear content but keep row) ?sheet_name=Sheet1
router.post(
  "/spreadsheets/:spreadsheetId/rows/:rowNumber/clear",
  catchAsync(GoogleSheetsController.clearRow)
);

// ─── Actions: Spreadsheet & Worksheet ────────────────────────────────────────
router.post("/spreadsheets", catchAsync(GoogleSheetsController.createSpreadsheet));

router.post(
  "/spreadsheets/:spreadsheetId/worksheets",
  catchAsync(GoogleSheetsController.createWorksheet)
);

// ─── Watch Management (polling subscriptions) ─────────────────────────────────
router.get("/watches",    catchAsync(GoogleSheetsController.listWatches));
router.post("/watches",   catchAsync(GoogleSheetsController.createWatch));
router.delete("/watches", catchAsync(GoogleSheetsController.deleteWatch));
router.post("/sync",      catchAsync(GoogleSheetsController.syncAllWatches));

export default router;
