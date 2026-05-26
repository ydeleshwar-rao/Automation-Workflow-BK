import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware.js";
import {
  resolveTargetUser,
  requireRole,
} from "../../middlewares/access.middleware.js";
import { AccessController } from "./access.controller.js";

const router = Router();

// All access endpoints require a logged-in user.
router.use(authMiddleware);

// Session/context
router.get("/me", resolveTargetUser, AccessController.me);

// Clients the caller can see (developer picks from this list).
router.get("/clients", AccessController.listClients);

// Admin-only: list users (filter by role)
router.get(
  "/users",
  requireRole("admin"),
  AccessController.listUsers
);

// Admin-only: developer ↔ client mapping
router.get(
  "/assignments",
  requireRole("admin"),
  AccessController.listAssignments
);
router.post(
  "/assignments",
  requireRole("admin"),
  AccessController.assign
);
router.delete(
  "/assignments",
  requireRole("admin"),
  AccessController.revoke
);

// Per-user/page permissions (users can read their own, admins can read any)
router.get(
  "/permissions/:user_id",
  AccessController.listPermissions
);
router.post(
  "/permissions",
  requireRole("admin"),
  AccessController.upsertPermission
);
router.delete(
  "/permissions",
  requireRole("admin"),
  AccessController.deletePermission
);

// Developer-scoped permissions (developers can read their own, admins can read any)
router.get(
  "/developer-permissions/:developer_id/:client_user_id",
  AccessController.listDeveloperPermissions
);
router.post(
  "/developer-permissions",
  requireRole("admin"),
  AccessController.upsertDeveloperPermission
);
router.delete(
  "/developer-permissions",
  requireRole("admin"),
  AccessController.deleteDeveloperPermission
);

export default router;
