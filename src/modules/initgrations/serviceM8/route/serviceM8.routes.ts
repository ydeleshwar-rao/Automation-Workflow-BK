import { Router } from "express";
import { ServiceM8Controller } from "../controller/serviceM8.controller.js";
// import { authMiddleware } from "../../../../middlewares/auth.middleware.js";

const router = Router();

// All ServiceM8 routes require a valid Supabase access token (Authorization: Bearer <token>)
// router.use(authMiddleware);

// ─── OAuth Connect / Disconnect ───────────────────────────
router.get("/connect", ServiceM8Controller.getConnectUrl);         // Connect URL lo
router.get("/callback", ServiceM8Controller.handleCallback);       // OAuth callback
router.delete("/disconnect", ServiceM8Controller.disconnect);        // Disconnect
router.get("/status", ServiceM8Controller.connectionStatus);       // Connected hai ya nahi
router.post("/backfill-account-uuid", ServiceM8Controller.backfillAccountUuid); // One-time migration

// ─── Username/Password Authentication ─────────────────────
router.post("/authenticate", ServiceM8Controller.authenticateWithCredentials); // Username/password auth

// ─── Clients ──────────────────────────────────────────────
router.get("/listclients", ServiceM8Controller.listClients);
router.post("/createclients", ServiceM8Controller.createClient);
router.post("/updateclients/:id", ServiceM8Controller.updateClient);

// ─── Contacts ─────────────────────────────────────────────
router.get("/listcontacts", ServiceM8Controller.listContacts);
// router.post("/createcontacts", ServiceM8Controller.createContact);
// router.post("/updatecontacts/:id", ServiceM8Controller.updateContact);

// ---queue
router.get("/listqueues", ServiceM8Controller.listQueues);
// ─── Categories ───────────────────────────────────────────
router.get("/listcategories", ServiceM8Controller.listCategories);
// router.post("/createcategories", ServiceM8Controller.createCategory);
// router.post("/updatecategories/:id", ServiceM8Controller.updateCategory);

//-- payments
router.get("/listpayments", ServiceM8Controller.listJobPayments);

// ─── Materials ─────────────────────────────────────────────
router.get("/listmaterials", ServiceM8Controller.listMaterials);
// ─── Materials ─────────────────────────────────────────────
router.get("/listjobmaterials", ServiceM8Controller.listJobMaterials);

// ─── Locations ────────────────────────────────────────────
router.get("/listlocations", ServiceM8Controller.listLocations);
router.post("/createlocations", ServiceM8Controller.createLocation);

// ─── Jobs ─────────────────────────────────────────────────
router.get("/listjobs", ServiceM8Controller.listJobs);
router.post("/createjobs", ServiceM8Controller.createJob);
router.post("/updatejobs/:id", ServiceM8Controller.updateJob);

// ─── Job Allocations ──────────────────────────────────────
router.get("/listjoballocations", ServiceM8Controller.listJobAllocations);
router.post("/createjoballocations", ServiceM8Controller.createJobAllocation);

// ─── Job Materials ────────────────────────────────────────
router.get("/listjobmaterials", ServiceM8Controller.listJobMaterials);
router.post("/createjobmaterials", ServiceM8Controller.createJobMaterial);

// ─── Notes ────────────────────────────────────────────────
 router.get("/listnotes", ServiceM8Controller.listNotes);
// router.post("/createnotes", ServiceM8Controller.createNote);

// ─── Staff Members ────────────────────────────────────────
router.get("/liststaffmembers", ServiceM8Controller.listStaffMembers);
router.get("/listactivestaff", ServiceM8Controller.listActiveStaff);


// ─── Sync All ─────────────────────────────────────────────────────────────────
router.post("/sync", ServiceM8Controller.syncAll);

// ─── Get Job Details (Summary) ───────────────────────────────────────────────
router.get(
  "/getjobs",
  ServiceM8Controller.getJobFullDetailsByEmailOrPhone
); // ?email= or ?phone=  GET /getjobs?email=foo@bar.com
// GET /getjobs?phone=0412345678
// GET /getjobs?email=foo@bar.com&phone=0412345678
router.get("/getjobdetails/:generatedJobId", ServiceM8Controller.getJobFullDetails);
router.get("/getjobids", ServiceM8Controller.getJobIds);
router.get("/getalljobs", ServiceM8Controller.getAllJobs);

// ─── Job Statuses ────────────────────────────────────────────────────────
router.get("/getjobstatuses", ServiceM8Controller.getJobStatuses);

// ─── Staffs ───────────────────────────────────────────────────────────────
router.get("/getstaffs", ServiceM8Controller.getStaffs); // ?job_title=Engineer

export default router;