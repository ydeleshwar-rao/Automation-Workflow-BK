// template.router.ts

import { Router } from "express";
import {
  createTemplateController,
  listTemplatesController,
  getTemplateByIdController,
  updateTemplateController,
  deleteTemplateController,
  applyTemplateController,
} from "./template.controller.js";

const router = Router();

router.post("/create", createTemplateController);
router.get("/", listTemplatesController);
router.get("/:id", getTemplateByIdController);
router.patch("/:id", updateTemplateController);
router.delete("/:id", deleteTemplateController);
router.post("/:id/apply", applyTemplateController);

export default router;
