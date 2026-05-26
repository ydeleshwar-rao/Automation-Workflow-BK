import { Router } from "express";
import {
  syncContactsController,
  getLocalContactsController,
  createContactController,
} from "../controllers/contacts.controller.js";

const router = Router();

router.get("/sync/:locationId", syncContactsController);
router.post("/createlead", createContactController);
router.get("/local/:locationId", getLocalContactsController);

export default router;
