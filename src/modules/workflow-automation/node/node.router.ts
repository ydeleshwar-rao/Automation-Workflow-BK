import { Router } from "express";
import {
  createNodeController,
  updateNodeController,
  deleteNodeController,
  getNodesByWorkflowController,
} from "./node.controller.js";

const router = Router();
//working
// Create Node
router.post("/create/:workflowId", createNodeController);

// Update Node
router.patch("/update/:id", updateNodeController);

// Delete Node not yet
router.delete("/delete/:id", deleteNodeController);

// Get all nodes for a workflow
router.get("/getNodes/:workflowId", getNodesByWorkflowController);

export default router;