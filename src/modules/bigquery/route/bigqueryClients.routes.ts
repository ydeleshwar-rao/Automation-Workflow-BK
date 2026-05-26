import { Router } from "express";

import { BigQueryClientsController } from "../controller/bigqueryClients.controller.js";
import { catchAsync } from "../../../utils/catchAsync.js";

const router = Router();

// GET /admin/reporting/bigquery/clients?limit=500
router.get(
  "/getclientskeydetails",
  // here you can add auth middleware if needed
  catchAsync(BigQueryClientsController.getClients)
);

export default router;