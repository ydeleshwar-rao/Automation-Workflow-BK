import { Router } from "express";
import {
  ghlInstallController,
  ghlCallbackController,
  ghlDisconnectController,
  ghlStatusController,
} from "../controllers/ghl.controller.js";

const router = Router();

router.get("/connect", ghlInstallController);
router.get("/callback", ghlCallbackController);
router.get("/status", ghlStatusController);
router.delete("/disconnect", ghlDisconnectController);


export default router;
