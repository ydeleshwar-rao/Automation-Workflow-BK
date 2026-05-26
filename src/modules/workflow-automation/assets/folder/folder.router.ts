import { Router } from "express";
import {
  createFolderController,
  getFoldersController,
  updateFolderController,
  deleteFolderController,
  reorderFoldersController,
} from "./folder.controller.js";

const router = Router();

router.post("/create", createFolderController);
router.get("/getAll", getFoldersController);
router.post("/reorder", reorderFoldersController);
router.patch("/:id", updateFolderController);
router.delete("/:id", deleteFolderController);

export default router;
