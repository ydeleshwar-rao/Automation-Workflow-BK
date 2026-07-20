import type { Request, Response } from "express";
import { catchAsync }    from "../../utils/catchAsync.js";
import { ApiResponse }   from "../../utils/ApiResponse.js";
import { ApiError }      from "../../utils/ApiError.js";
import { AccessService } from "./access.service.js";

const getParam = (value: string | string[] | undefined, name: string): string => {
  if (!value || Array.isArray(value)) throw new ApiError(400, `${name} is required`);
  return value;
};

export class AccessController {

  // ── Session ────────────────────────────────────────────────────────────────

  /** GET /access/me — current logged-in user info from JWT. */
  static me = catchAsync(async (req: Request, res: Response) => {
    if (!req.user?.id) throw new ApiError(401, "Unauthorized");
    return ApiResponse(res, 200, "Current session", {
      id:          req.user.id,
      email:       req.user.email,
      role:        req.user.role,
      organization_id: req.user.organizationId,
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
    const data = await AccessService.listDevelopers(req.user.role, req.user.id, req.user.organizationId);
    return ApiResponse(res, 200, "Developers", data);
  });

  /**
   * GET /access/developers/:id
   * Admin: get any developer. Developer: get self only.
   */
  static getDeveloper = catchAsync(async (req: Request, res: Response) => {
    const devId = getParam(req.params.id, "Developer ID");
    if (req.user?.role !== "admin" && req.user?.id !== devId) {
      throw new ApiError(403, "You can only view your own profile");
    }
    const data = await AccessService.getDeveloper(devId, req.user?.organizationId);
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

    const createInput = {
      email:       email.trim().toLowerCase(),
      fullName:    full_name.trim(),
      createdById: req.user.id,
      organizationId: req.user.organizationId,
      permissions,
      ...(password !== undefined ? { password } : {}),
    };

    const data = await AccessService.createDeveloper(createInput);

    return ApiResponse(res, 201, "Developer created", data);
  });

  /**
   * PATCH /access/developers/:id/status  (admin only)
   * Body: { is_active: boolean }
   */
  static toggleDeveloperStatus = catchAsync(async (req: Request, res: Response) => {
    const devId    = getParam(req.params.id, "Developer ID");
    const isActive = req.body?.is_active;

    if (typeof isActive !== "boolean") throw new ApiError(400, "is_active (boolean) is required");

    const data = await AccessService.toggleDeveloperStatus(devId, isActive, req.user?.organizationId);
    return ApiResponse(res, 200, `Developer ${isActive ? "activated" : "deactivated"}`, data);
  });

  /**
   * DELETE /access/developers/:id  (admin only)
   * Permanently deletes Supabase auth user + all data (cascades).
   */
  static deleteDeveloper = catchAsync(async (req: Request, res: Response) => {
    const devId = getParam(req.params.id, "Developer ID");

    const data = await AccessService.deleteDeveloper(devId, req.user?.organizationId);
    return ApiResponse(res, 200, "Developer deleted", data);
  });

  // ── Admin Management (Admin only) ─────────────────────────────────────────

  /**
   * GET /access/admins  (admin only)
   * Lists all admin accounts.
   */
  static listAdmins = catchAsync(async (req: Request, res: Response) => {
    if (!req.user?.id) throw new ApiError(401, "Unauthorized");
    const data = await AccessService.listAdmins(req.user.organizationId);
    return ApiResponse(res, 200, "Admins", data);
  });

  /**
   * DELETE /access/admins/:id  (admin only)
   * Permanently deletes an admin account.
   * Cannot delete yourself or the last admin.
   */
  static deleteAdmin = catchAsync(async (req: Request, res: Response) => {
    const adminId = getParam(req.params.id, "Admin ID");
    if (!req.user?.id) throw new ApiError(401, "Unauthorized");

    const data = await AccessService.deleteAdmin(adminId, req.user.id, req.user.organizationId);
    return ApiResponse(res, 200, "Admin deleted", data);
  });

  // ── Page Permissions ───────────────────────────────────────────────────────

  /**
   * GET /access/developers/:id/permissions
   * Admin: view any developer's permissions. Developer: view self only.
   */
  static getPermissions = catchAsync(async (req: Request, res: Response) => {
    const userId = getParam(req.params.id, "User ID");
    if (req.user?.role !== "admin" && req.user?.id !== userId) {
      throw new ApiError(403, "You can only view your own permissions");
    }
    const data = await AccessService.getPagePermissions(userId, req.user?.organizationId);
    return ApiResponse(res, 200, "Page permissions", data);
  });

  /**
   * PUT /access/developers/:id/permissions  (admin only)
   * Body: { permissions: [{ page_key, can_view, can_edit?, can_delete? }] }
   * Replaces ALL permissions for the developer.
   */
  static setPermissions = catchAsync(async (req: Request, res: Response) => {
    const userId = getParam(req.params.id, "User ID");
    const { permissions } = req.body as {
      permissions?: Array<{ page_key: string; can_view: boolean; can_edit?: boolean; can_delete?: boolean }>;
    };

    if (!Array.isArray(permissions)) throw new ApiError(400, "permissions[] is required");
    if (!req.user?.id)               throw new ApiError(401, "Unauthorized");

    const data = await AccessService.setPagePermissions(userId, permissions, req.user.id, req.user.organizationId);
    return ApiResponse(res, 200, "Permissions updated", data);
  });

  /**
   * PATCH /access/developers/:id/permissions/:page_key  (admin only)
   * Body: { can_view?, can_edit?, can_delete? }
   * Updates a single page permission.
   */
  static upsertPermission = catchAsync(async (req: Request, res: Response) => {
    const userId = getParam(req.params.id, "User ID");
    const pageKey = getParam(req.params.page_key, "page_key");
    const { can_view, can_edit, can_delete } = req.body as {
      can_view?:   boolean;
      can_edit?:   boolean;
      can_delete?: boolean;
    };

    if (!req.user?.id)       throw new ApiError(401, "Unauthorized");

    const updates = {
      ...(can_view !== undefined ? { canView: can_view } : {}),
      ...(can_edit !== undefined ? { canEdit: can_edit } : {}),
      ...(can_delete !== undefined ? { canDelete: can_delete } : {}),
    };

    const data = await AccessService.upsertPagePermission(
      userId,
      pageKey,
      updates,
      req.user.id,
      req.user.organizationId
    );
    return ApiResponse(res, 200, "Permission updated", data);
  });

  /**
   * DELETE /access/developers/:id/permissions/:page_key  (admin only)
   */
  static removePermission = catchAsync(async (req: Request, res: Response) => {
    const userId = getParam(req.params.id, "User ID");
    const pageKey = getParam(req.params.page_key, "page_key");

    const data = await AccessService.removePagePermission(userId, pageKey, req.user?.organizationId);
    return ApiResponse(res, 200, "Permission removed", data);
  });
}
