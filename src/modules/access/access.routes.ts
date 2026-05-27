import { Router }            from "express";
import { authMiddleware }    from "../../middlewares/auth.middleware.js";
import { requireRole }       from "../../middlewares/access.middleware.js";
import { AccessController }  from "./access.controller.js";

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// ── Session ──────────────────────────────────────────────────────────────────
// GET /access/me → returns current user info from JWT (no DB call)
router.get("/me", AccessController.me);

// ── Developer Management ─────────────────────────────────────────────────────
// GET    /access/developers              → admin: all, developer: self
// POST   /access/developers              → admin only: create developer
// GET    /access/developers/:id          → admin: any, developer: self
// PATCH  /access/developers/:id/status   → admin only: activate/deactivate
// DELETE /access/developers/:id          → admin only: delete developer

router.get(  "/developers",                   AccessController.listDevelopers);
router.post( "/developers",     requireRole("admin"), AccessController.createDeveloper);
router.get(  "/developers/:id",               AccessController.getDeveloper);
router.patch("/developers/:id/status", requireRole("admin"), AccessController.toggleDeveloperStatus);
router.delete("/developers/:id",       requireRole("admin"), AccessController.deleteDeveloper);

// ── Admin Management ─────────────────────────────────────────────────────────
// GET    /access/admins        → admin only: list all admin accounts
// DELETE /access/admins/:id    → admin only: delete admin (guards: not self, not last)

router.get(   "/admins",         requireRole("admin"), AccessController.listAdmins);
router.delete("/admins/:id",     requireRole("admin"), AccessController.deleteAdmin);

// ── Page Permissions ─────────────────────────────────────────────────────────
// GET    /access/developers/:id/permissions                → admin: any, developer: self
// PUT    /access/developers/:id/permissions                → admin only: replace ALL permissions
// PATCH  /access/developers/:id/permissions/:page_key     → admin only: upsert one permission
// DELETE /access/developers/:id/permissions/:page_key     → admin only: remove one permission

router.get(   "/developers/:id/permissions",                                    AccessController.getPermissions);
router.put(   "/developers/:id/permissions",       requireRole("admin"),        AccessController.setPermissions);
router.patch( "/developers/:id/permissions/:page_key", requireRole("admin"),   AccessController.upsertPermission);
router.delete("/developers/:id/permissions/:page_key", requireRole("admin"),   AccessController.removePermission);

export default router;
