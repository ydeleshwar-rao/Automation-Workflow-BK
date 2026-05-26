import Router from "express";
import { syncPipelinesController, getPipelinesController } from "../controllers/pipelines.controller.js"

const router = Router();
router.get("/sync", syncPipelinesController);
router.get("/all", getPipelinesController);
export default router;