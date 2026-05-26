import { Router } from "express";
import {
  getActionTypesLeadshubController,
  getLeadshubTriggersController,
  getLeadshubActionsController,
  getServiceM8TriggersController,
  getServiceM8ActionsController,
  getCommusoftTriggersController,
  getCommusoftActionsController,
  getSimproTriggersController,
  getSimproActionsController,
} from "./action_event_type.controller.js";

const router = Router();

// GET /automation/action-event-types
router.get("/leadshub", getActionTypesLeadshubController);
router.get("/leadshub/triggers", getLeadshubTriggersController);
router.get("/leadshub/actions", getLeadshubActionsController);

router.get("/service-m8/triggers", getServiceM8TriggersController);
router.get("/service-m8/actions", getServiceM8ActionsController);

router.get("/commusoft/triggers", getCommusoftTriggersController);
router.get("/commusoft/actions", getCommusoftActionsController);

router.get("/simpro/triggers", getSimproTriggersController);
router.get("/simpro/actions", getSimproActionsController);

export default router;
