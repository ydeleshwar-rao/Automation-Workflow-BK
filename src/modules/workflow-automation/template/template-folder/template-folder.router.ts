// template-folder.router.ts

import { Router } from "express";
import {
  bulkApplyFolderController,
  createTemplateFolderController,
  deleteTemplateFolderController,
  getIntegrationStatusController,
  getRequiredIntegrationsController,
  listTemplateFoldersController,
  updateTemplateFolderController,
} from "./template-folder.controller.js";
import { authMiddleware } from "../../../../middlewares/auth.middleware.js";

const router = Router();

router.post("/create", createTemplateFolderController);
router.get("/", listTemplateFoldersController);

// Static routes BEFORE /:id to avoid param conflicts
// authMiddleware required so req.user is populated for role-based access control
router.get("/integration-status/:userId", authMiddleware, getIntegrationStatusController);

router.get("/:id/required-integrations", getRequiredIntegrationsController);
router.patch("/:id", updateTemplateFolderController);
router.delete("/:id", deleteTemplateFolderController);
router.post("/:id/bulk-apply", bulkApplyFolderController);

export default router;
