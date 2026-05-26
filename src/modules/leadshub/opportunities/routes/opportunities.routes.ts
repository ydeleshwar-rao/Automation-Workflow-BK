import { Router }from "express";
import { updateOpportunityController, syncOpportunitiesController, syncOpportunityController, testAddUpdateOpportunityController } from "../controllers/opportunities.controller.js";

const router = Router();

router.get("/all/sync/:locationId", syncOpportunitiesController);
router.get("/sync/:opportunityId", syncOpportunityController);
console.log("🚀 Opportunities Routes Updated");
router.put("/update/:opportunityId", updateOpportunityController);
router.post("/test/add-update", testAddUpdateOpportunityController);

export default router;