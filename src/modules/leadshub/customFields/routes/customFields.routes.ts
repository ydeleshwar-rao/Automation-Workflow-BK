import Router from "express";
import {getCustomFieldsController} from "../controllers/customFields.controller.js"


const router = Router();

router.get("/all",getCustomFieldsController);

export default router;