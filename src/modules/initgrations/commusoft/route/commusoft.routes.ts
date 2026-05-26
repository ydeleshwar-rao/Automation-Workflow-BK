import compression from "compression";
import { Router } from "express";
import { catchAsync } from "../../../../utils/catchAsync.js";

import { CommusoftController } from "../controller/commusoft.controller.js";

const router = Router();


// Connection management
router.post("/connect", catchAsync(CommusoftController.generateAccessToken));
router.get("/status", catchAsync(CommusoftController.getConnectionStatus));
router.delete("/disconnect", catchAsync(CommusoftController.disconnect));

// // Additional endpoints
router.post("/customers/sync", catchAsync(CommusoftController.syncCustomersDirectory));
router.get("/customers", catchAsync(CommusoftController.getCustomers));
router.post(
  "/customerdetails/sync",
  catchAsync(CommusoftController.syncCustomerDetails)
);
router.get(
  "/customerdetails",
  compression({ level: 6 }),
  catchAsync(CommusoftController.getCustomerDetails)
);
 router.get("/jobs", catchAsync(CommusoftController.getJobs));
// router.get("/customers/:id/jobs", catchAsync(CommusoftController.getJobsByCustomerId));
 //router.get("/engineers", catchAsync(CommusoftController.getEngineers));
router.get("/jobdescriptions", catchAsync(CommusoftController.getJobDescriptions));

router.post("/sync", catchAsync(CommusoftController.syncAll))
router.get("/sync/status", catchAsync(CommusoftController.getSyncStatus));
router.get("/getjobs", catchAsync(CommusoftController.getJobsByEmailOrPhone));
router.get("/userpreference", catchAsync(CommusoftController.getUserPreference));
router.get("/diaryevents", catchAsync(CommusoftController.getDiaryEvents));
router.get("/getalljobs", catchAsync(CommusoftController.getAllJobs));
router.get("/liststaffmembers", catchAsync(CommusoftController.getStaffMembers));
router.get("/customertypes", catchAsync(CommusoftController.getCustomerTypes));
router.get("/opportunity-pipelines", catchAsync(CommusoftController.getOpportunityPipelines));
router.get("/opportunity-pipelines/:pipelineId/stages", catchAsync(CommusoftController.getOpportunityPipelineStages));
router.get("/opportunity-templates", catchAsync(CommusoftController.getOpportunityTemplates));
router.get("/estimates/outstanding", catchAsync(CommusoftController.getOutstandingJobsAndEstimates));
router.get("/sales-stages/scan", catchAsync(CommusoftController.scanStageOpportunities));
router.get("/sales-stages/:stageId/opportunities", catchAsync(CommusoftController.getStageOpportunities));
router.get("/opportunities/:opportunityId", catchAsync(CommusoftController.getOpportunityDetails));
router.get("/customers/:customerId/opportunities/:opportunityId/stages", catchAsync(CommusoftController.getCustomerOpportunityStages));
router.post("/customers/create", catchAsync(CommusoftController.createCustomer));
router.post("/jobs/create", catchAsync(CommusoftController.createJob));
router.post("/diaryevents/create", catchAsync(CommusoftController.createDiaryEvent));
router.post("/opportunities/create", catchAsync(CommusoftController.createOpportunity));

export default router;
