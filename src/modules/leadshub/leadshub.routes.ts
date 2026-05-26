import { Router } from "express";
import ghlRoutes from "./ghl/routes/ghl.routes.js";
import contactsRoutes from "./contacts/routes/contacts.routes.js";
import opportunitiesRoutes from "./opportunities/routes/opportunities.routes.js";
import pipelinesRoutes from "./opportunities/pipelines/routes/pipelines.routes.js";
import customFieldsRouter from "./customFields/routes/customFields.routes.js";
import tagsRouters from "./tags/routes/tag.routes.js";
import calendarsRoutes from "./calendars/routes/calendars.routes.js";

const leadsHubRouter = Router();

leadsHubRouter.use("/auth", ghlRoutes);
leadsHubRouter.use("/contacts", contactsRoutes);
leadsHubRouter.use("/opportunities", opportunitiesRoutes);
leadsHubRouter.use("/pipelines", pipelinesRoutes);
leadsHubRouter.use("/customfields", customFieldsRouter);
leadsHubRouter.use("/tags", tagsRouters);
leadsHubRouter.use("/calendars", calendarsRoutes);

export default leadsHubRouter;
