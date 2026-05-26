import Router from "express";
import { getTagsController } from "../controllers/tags.controller.js"
const router = Router();

router.get("/all",getTagsController)

export default router;