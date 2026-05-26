import { Router } from "express";
import workflowRoutes from "./workflow/workflow.router.js";
import nodeRoutes from "./node/node.router.js";
import executionRoutes from "./execution/execution.router.js";
import mappingRoutes from "./field_mapping/mapping.router.js";
import actionEventTypeRoutes from "./action_event_type/action_event_type.router.js";
import folderRoutes from "./assets/folder/folder.router.js";
import workflowTagRoutes from "./assets/workflow-tags/workflow-tags.router.js";
import templateRoutes from "./template/template.router.js";
import templateFolderRoutes from "./template/template-folder/template-folder.router.js";
import pollingRoutes from "../polling-engine/polling.routes.js";

const automationRouter = Router();

automationRouter.use("/workflows", workflowRoutes);
automationRouter.use("/workflows/nodes", nodeRoutes);
automationRouter.use("/workflows", executionRoutes);
automationRouter.use("/workflows/test", mappingRoutes);
automationRouter.use("/action-event-types", actionEventTypeRoutes);
automationRouter.use("/folders", folderRoutes);
automationRouter.use("/tags", workflowTagRoutes);
automationRouter.use("/workflow-templates", templateRoutes);
automationRouter.use("/workflow-template-folders", templateFolderRoutes);
automationRouter.use("/polling", pollingRoutes);

export default automationRouter;
