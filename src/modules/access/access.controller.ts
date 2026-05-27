import type { Request, Response } from "express";
import { catchAsync }    from "../../utils/catchAsync.js";
import { ApiResponse }   from "../../utils/ApiResponse.js";
import { ApiError }      from "../../utils/ApiError.js";
import { AccessService } from "./access.service.js";

export class AccessController {

  // ── Session ────────────────────────────────────────────────────────────────

  /** GET /access/me — current logged-in user info from JWT. */
  static me = catchAsync(async (req: Request, res: Response) => {
    if (!req.user?.id) throw new ApiError(401, "Unauthorized");
    return ApiResponse(res, 200, "Current session", {
      id:          req.user.id,
      email:       req.user.email,
      role:        req.user.role,
      permissions: req.user.permissions,
    });
  });

  // ── Developer Management (Admin only) ─────────────────────────────────────

  /**
   * GET /access/developers
   * Admin: list all developers with their page permissions.
   * Developer: returns self only.
   */
  static listDevelopers = catchAsync(async (req: Request, res: Response) => {
    if (!req.user?.id) throw new ApiError(401, "Unauthorized");
    const data = await AccessService.listDevelopers(req.user.role, req.user.id);
    return ApiResponse(res, 200, "Developers", data);
  });

  /**
   * GET /access/developers/:id
   * Admin: get any developer. Developer: get self only.
   */
  static getDeveloper = catchAsync(async (req: Request, res: Response) => {
    const devId = req.params.id;
    if (!devId) throw new ApiError(400, "Developer ID is required");
    if (req.user?.role !== "admin" && req.user?.id !== devId) {
      throw new ApiError(403, "You can only view your own profile");
    }
    const data = await AccessService.getDeveloper(devId);
    return ApiResponse(res, 200, "Developer", data);
  });

  /**
   * POST /access/developers  (admin only)
   * Body: { email, full_name, permissions: [{ page_key, can_view, can_edit?, can_delete? }] }
   * Creates Supabase auth user + profile + page permissions.
   * Returns profile + temp_password for initial login.
   */
  static createDeveloper = catchAsync(async (req: Request, res: Response) => {
    const { email, full_name, permissions = [], password } = req.body as {
      email?:       string;
      full_name?:   string;
      permissions?: Array<{ page_key: string; can_view: boolean; can_edit?: boolean; can_delete?: boolean }>;
      password?:    string;
    };

    if (!email?.trim())     throw new ApiError(400, "email is required");
    if (!full_name?.trim()) throw new ApiError(400, "full_name is required");
    if (!req.user?.id)      throw new ApiError(401, "Unauthorized");

    const data = await AccessService.createDeveloper({
      email:       email.trim().toLowerCase(),
      fullName:    full_name.trim(),
      createdById: req.user.id,
      permissions,
      password,
    });

    return ApiResponse(res, 201, "Developer created", data);
  });

  /**
   * PATCH /access/developers/:id/status  (admin only)
   * Body: { is_active: boolean }
   */
  static toggleDeveloperStatus = catchAsync(async (req: Request, res: Response) => {
    const devId    = req.params.id;
    const isActive = req.body?.is_active;

    if (!devId)                    throw new ApiError(400, "Developer ID is required");
    if (typeof isActive !== "boolean") throw new ApiError(400, "is_active (boolean) is required");

    const data = await AccessService.toggleDeveloperStatus(devId, isActive);
    return ApiResponse(res, 200, `Developer ${isActive ? "activated" : "deactivated"}`, data);
  });

  /**
   * DELETE /access/developers/:id  (admin only)
   * Permanently deletes Supabase auth user + all data (cascades).
   */
  static deleteDeveloper = catchAsync(async (req: Request, res: Response) => {
    const devId = req.params.id;
    if (!devId) throw new ApiError(400, "Developer ID is required");

    const data = await AccessService.deleteDeveloper(devId);
    return ApiResponse(res, 200, "Developer deleted", data);
  });

  // ── Admin Management (Admin only) ─────────────────────────────────────────

  /**
   * GET /access/admins  (admin only)
   * Lists all admin accounts.
   */
  static listAdmins = catchAsync(async (req: Request, res: Response) => {
    if (!req.user?.id) throw new ApiError(401, "Unauthorized");
    const data = await AccessService.listAdmins();
    return ApiResponse(res, 200, "Admins", data);
  });

  /**
   * DELETE /access/admins/:id  (admin only)
   * Permanently deletes an admin account.
   * Cannot delete yourself or the last admin.
   */
  static deleteAdmin = catchAsync(async (req: Request, res: Response) => {
    const adminId = req.params.id;
    if (!adminId)      throw new ApiError(400, "Admin ID is required");
    if (!req.user?.id) throw new ApiError(401, "Unauthorized");

    const data = await AccessService.deleteAdmin(adminId, req.user.id);
    return ApiResponse(res, 200, "Admin deleted", data);
  });

  // ── Page Permissions ───────────────────────────────────────────────────────

  /**
   * GET /access/developers/:id/permissions
   * Admin: view any developer's permissions. Developer: view self only.
   */
  static getPermissions = catchAsync(async (req: Request, res: Response) => {
    const userId = req.params.id;
    if (!userId) throw new ApiError(400, "User ID is required");
    if (req.user?.role !== "admin" && req.user?.id !== userId) {
      throw new ApiError(403, "You can only view your own permissions");
    }
    const data = await AccessService.getPagePermissions(userId);
    return ApiResponse(res, 200, "Page permissions", data);
  });

  /**
   * PUT /access/developers/:id/permissions  (admin only)
   * Body: { permissions: [{ page_key, can_view, can_edit?, can_delete? }] }
   * Replaces ALL permissions for the developer.
   */
  static setPermissions = catchAsync(async (req: Request, res: Response) => {
    const userId = req.params.id;
    const { permissions } = req.body as {
      permissions?: Array<{ page_key: string; can_view: boolean; can_edit?: boolean; can_delete?: boolean }>;
    };

    if (!userId)                     throw new ApiError(400, "User ID is required");
    if (!Array.isArray(permissions)) throw new ApiError(400, "permissions[] is required");
    if (!req.user?.id)               throw new ApiError(401, "Unauthorized");

    const data = await AccessService.setPagePermissions(userId, permissions, req.user.id);
    return ApiResponse(res, 200, "Permissions updated", data);
  });

  /**
   * PATCH /access/developers/:id/permissions/:page_key  (admin only)
   * Body: { can_view?, can_edit?, can_delete? }
   * Updates a single page permission.
   */
  static upsertPermission = catchAsync(async (req: Request, res: Response) => {
    const { id: userId, page_key: pageKey } = req.params;
    const { can_view, can_edit, can_delete } = req.body as {
      can_view?:   boolean;
      can_edit?:   boolean;
      can_delete?: boolean;
    };

    if (!userId || !pageKey) throw new ApiError(400, "User ID and page_key are required");
    if (!req.user?.id)       throw new ApiError(401, "Unauthorized");

    const data = await AccessService.upsertPagePermission(
      userId,
      pageKey,
      { canView: can_view, canEdit: can_edit, canDelete: can_delete },
      req.user.id
    );
    return ApiResponse(res, 200, "Permission updated", data);
  });

  /**
   * DELETE /access/developers/:id/permissions/:page_key  (admin only)
   */
  static removePermission = catchAsync(async (req: Request, res: Response) => {
    const { id: userId, page_key: pageKey } = req.params;
    if (!userId || !pageKey) throw new ApiError(400, "User ID and page_key are required");

    const data = await AccessService.removePagePermission(userId, pageKey);
    return ApiResponse(res, 200, "Permission removed", data);
  });
}
