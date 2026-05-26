import { Router } from "express";
import {
  createMappingController,
  createMappingsBulkController,
  getMappingsController,
  deleteMappingController,
} from "./mapping.controller.js";

const router = Router();

// Single mapping create
router.post("/nodes/:id/mappings", createMappingController);

// Bulk mapping save — replaces ALL mappings for the node atomically
// Body: { mappings: [...] }
router.post("/nodes/:id/mappings/bulk", createMappingsBulkController);

router.get("/nodes/:id/mappings", getMappingsController);
router.delete("/nodes/:id/mappings/:destinationField", deleteMappingController);

export default router;