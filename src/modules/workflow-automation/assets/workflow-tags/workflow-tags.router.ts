import { Router } from "express";
import {
  createTagController,
  getTagsController,
  updateTagController,
  deleteTagController,
  addTagToWorkflowController,
  removeTagFromWorkflowController,
  getTagsByWorkflowController,
  getWorkflowsByTagController,
} from "./workflow-tags.controller.js";

const router = Router();

// Tag CRUD
router.post("/create", createTagController);
router.get("/getAll", getTagsController);
router.patch("/:id", updateTagController);
router.delete("/:id", deleteTagController);

// Workflow ↔ Tag linking
router.post("/workflow/:workflowId", addTagToWorkflowController);
router.delete("/workflow/:workflowId/:tagId", removeTagFromWorkflowController);
router.get("/workflow/:workflowId", getTagsByWorkflowController);
router.get("/filter/:tagId", getWorkflowsByTagController);

export default router;
