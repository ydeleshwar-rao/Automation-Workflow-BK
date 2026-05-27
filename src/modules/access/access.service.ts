import { supabase } from "../../config/db.config.js";
import { ApiError }  from "../../utils/ApiError.js";
import prisma        from "../../lib/prisma.js";
import crypto        from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PagePermissionInput {
  page_key:   string;
  can_view:   boolean;
  can_edit?:  boolean;
  can_delete?: boolean;
}

// ─── Access Service ───────────────────────────────────────────────────────────

export class AccessService {

  // ── Developer Management (Admin only) ─────────────────────────────────────

  /**
   * Create a new developer account.
   *  1. Create Supabase auth user
   *  2. Profile is auto-created by the DB trigger
   *  3. Set initial page permissions
   *
   * Returns the new user's profile + temp password (for initial login).
   */
  static async createDeveloper(payload: {
    email:       string;
    fullName:    string;
    createdById: string;
    permissions: PagePermissionInput[];
    password?:   string;        // if not provided, a secure random password is generated
  }) {
    const password = payload.password ?? crypto.randomBytes(12).toString("base64url");

    // Create Supabase auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email:          payload.email,
      password,
      email_confirm:  true,
      user_metadata:  { full_name: payload.fullName, role: "developer" },
    });

    if (authError) {
      if (authError.message.includes("already registered")) {
        throw new ApiError(409, "A user with this email already exists");
      }
      throw new ApiError(400, authError.message);
    }

    if (!authData.user?.id) {
      throw new ApiError(500, "Failed to create auth user");
    }

    const userId = authData.user.id;

    // Update profile (trigger creates it, we update name + created_by)
    await prisma.profile.update({
      where: { id: userId },
      data:  { fullName: payload.fullName, createdBy: payload.createdById },
    });

    // Set initial page permissions
    if (payload.permissions.length > 0) {
      await AccessService.setPagePermissions(userId, payload.permissions, payload.createdById);
    }

    const profile = await prisma.profile.findUnique({
      where:  { id: userId },
      select: {
        id:              true,
        email:           true,
        fullName:        true,
        role:            true,
        isActive:        true,
        createdAt:       true,
        pagePermissions: { select: { pageKey: true, canView: true, canEdit: true, canDelete: true } },
      },
    });

    return { profile, temp_password: password };
  }

  /**
   * List all developers (admin sees all, developer sees self only).
   */
  static async listDevelopers(callerRole: string, callerId: string) {
    if (callerRole === "admin") {
      return prisma.profile.findMany({
        where:   { role: "developer" },
        orderBy: { createdAt: "desc" },
        select: {
          id:              true,
          email:           true,
          fullName:        true,
          avatarUrl:       true,
          role:            true,
          isActive:        true,
          createdAt:       true,
          pagePermissions: { select: { pageKey: true, canView: true, canEdit: true, canDelete: true } },
        },
      });
    }

    // Developer can only see self
    const self = await prisma.profile.findUnique({
      where:  { id: callerId },
      select: {
        id: true, email: true, fullName: true, role: true,
        isActive: true, createdAt: true,
        pagePermissions: { select: { pageKey: true, canView: true, canEdit: true, canDelete: true } },
      },
    });
    return self ? [self] : [];
  }

  /**
   * Get a single developer's profile (admin only, or self).
   */
  static async getDeveloper(developerId: string) {
    const profile = await prisma.profile.findUnique({
      where:  { id: developerId },
      select: {
        id:              true,
        email:           true,
        fullName:        true,
        avatarUrl:       true,
        role:            true,
        isActive:        true,
        createdAt:       true,
        updatedAt:       true,
        pagePermissions: { select: { id: true, pageKey: true, canView: true, canEdit: true, canDelete: true } },
      },
    });
    if (!profile) throw new ApiError(404, "Developer not found");
    return profile;
  }

  /**
   * Toggle developer active/inactive (admin only).
   */
  static async toggleDeveloperStatus(developerId: string, isActive: boolean) {
    const profile = await prisma.profile.findUnique({ where: { id: developerId } });
    if (!profile) throw new ApiError(404, "Developer not found");
    if (profile.role !== "developer") throw new ApiError(400, "Target user is not a developer");

    return prisma.profile.update({
      where:  { id: developerId },
      data:   { isActive },
      select: { id: true, email: true, fullName: true, isActive: true, role: true },
    });
  }

  /**
   * Delete a developer account (admin only).
   * Removes Supabase auth user + all related data (cascades via DB).
   */
  static async deleteDeveloper(developerId: string) {
    const profile = await prisma.profile.findUnique({ where: { id: developerId } });
    if (!profile) throw new ApiError(404, "Developer not found");
    if (profile.role !== "developer") throw new ApiError(400, "Can only delete developer accounts");

    // Delete from Supabase auth (profile cascades via FK)
    const { error } = await supabase.auth.admin.deleteUser(developerId);
    if (error) throw new ApiError(500, `Failed to delete auth user: ${error.message}`);

    return { message: "Developer deleted successfully" };
  }

  // ── Admin Management ───────────────────────────────────────────────────────

  /**
   * List all admin accounts.
   */
  static async listAdmins() {
    return prisma.profile.findMany({
      where:   { role: "admin" },
      orderBy: { createdAt: "asc" },
      select: {
        id:        true,
        email:     true,
        fullName:  true,
        avatarUrl: true,
        role:      true,
        isActive:  true,
        createdAt: true,
      },
    });
  }

  /**
   * Delete an admin account (admin only).
   * Guards:
   *  - Cannot delete yourself
   *  - Cannot delete the last remaining admin (would lock everyone out)
   */
  static async deleteAdmin(adminId: string, callerId: string) {
    if (adminId === callerId) {
      throw new ApiError(400, "You cannot delete your own account while logged in");
    }

    const profile = await prisma.profile.findUnique({ where: { id: adminId } });
    if (!profile) throw new ApiError(404, "Admin account not found");
    if (profile.role !== "admin") throw new ApiError(400, "Target account is not an admin");

    // Guard: must keep at least one admin
    const adminCount = await prisma.profile.count({ where: { role: "admin" } });
    if (adminCount <= 1) {
      throw new ApiError(400, "Cannot delete the last admin account — add another admin first");
    }

    // Delete from Supabase auth (profile cascades via FK)
    const { error } = await supabase.auth.admin.deleteUser(adminId);
    if (error) throw new ApiError(500, `Failed to delete auth user: ${error.message}`);

    return { message: "Admin account deleted successfully" };
  }

  // ── Page Permissions ───────────────────────────────────────────────────────

  /**
   * Replace all page permissions for a developer.
   * Admin provides the full list — existing permissions are replaced.
   */
  static async setPagePermissions(
    userId:      string,
    permissions: PagePermissionInput[],
    grantedBy:   string
  ) {
    // Delete existing permissions for this user
    await prisma.pagePermission.deleteMany({ where: { userId } });

    if (permissions.length === 0) return [];

    // Insert new permissions
    const rows = permissions.map((p) => ({
      userId,
      pageKey:   p.page_key,
      canView:   p.can_view,
      canEdit:   p.can_edit   ?? false,
      canDelete: p.can_delete ?? false,
      grantedBy,
    }));

    await prisma.pagePermission.createMany({ data: rows });

    return prisma.pagePermission.findMany({
      where:   { userId },
      select:  { id: true, pageKey: true, canView: true, canEdit: true, canDelete: true },
      orderBy: { pageKey: "asc" },
    });
  }

  /**
   * Upsert a single page permission for a developer.
   */
  static async upsertPagePermission(
    userId:    string,
    pageKey:   string,
    data:      { canView?: boolean; canEdit?: boolean; canDelete?: boolean },
    grantedBy: string
  ) {
    return prisma.pagePermission.upsert({
      where:  { userId_pageKey: { userId, pageKey } },
      update: { ...data, grantedBy },
      create: { userId, pageKey, canView: data.canView ?? false, canEdit: data.canEdit ?? false, canDelete: data.canDelete ?? false, grantedBy },
    });
  }

  /**
   * Get all page permissions for a user.
   */
  static async getPagePermissions(userId: string) {
    return prisma.pagePermission.findMany({
      where:   { userId },
      select:  { id: true, pageKey: true, canView: true, canEdit: true, canDelete: true, updatedAt: true },
      orderBy: { pageKey: "asc" },
    });
  }

  /**
   * Remove a single page permission.
   */
  static async removePagePermission(userId: string, pageKey: string) {
    const perm = await prisma.pagePermission.findUnique({
      where: { userId_pageKey: { userId, pageKey } },
    });
    if (!perm) throw new ApiError(404, `Permission '${pageKey}' not found for this user`);

    await prisma.pagePermission.delete({ where: { userId_pageKey: { userId, pageKey } } });
    return { message: "Permission removed" };
  }
}
