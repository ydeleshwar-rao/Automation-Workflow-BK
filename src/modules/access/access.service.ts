import { supabase } from "../../config/db.config.js";
import { ApiError }  from "../../utils/ApiError.js";
import crypto        from "crypto";

export interface PagePermissionInput {
  page_key:   string;
  can_view:   boolean;
  can_edit?:  boolean;
  can_delete?: boolean;
}

type ProfileRow = {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: string;
  organization_id: string;
  is_active: boolean | null;
  created_at?: string;
  updated_at?: string;
};

type PermissionRow = {
  id?: string;
  page_key: string;
  can_view: boolean | null;
  can_edit: boolean | null;
  can_delete: boolean | null;
  updated_at?: string;
};

function mapProfile(row: ProfileRow, pagePermissions: PermissionRow[] = []) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name ?? "",
    avatarUrl: row.avatar_url,
    role: row.role,
    organizationId: row.organization_id,
    isActive: row.is_active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pagePermissions: pagePermissions.map(mapPermission),
  };
}

function mapPermission(row: PermissionRow) {
  return {
    id: row.id,
    pageKey: row.page_key,
    canView: row.can_view ?? false,
    canEdit: row.can_edit ?? false,
    canDelete: row.can_delete ?? false,
    updatedAt: row.updated_at,
  };
}

export class AccessService {
  private static async assertUserInOrganization(userId: string, organizationId: string) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id,organization_id")
      .eq("id", userId)
      .maybeSingle();

    if (error) throw new ApiError(500, error.message);
    if (!data || data.organization_id !== organizationId) {
      throw new ApiError(404, "User not found");
    }
  }

  private static async getProfileWithPermissions(userId: string) {
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id,email,full_name,avatar_url,role,organization_id,is_active,created_at,updated_at")
      .eq("id", userId)
      .maybeSingle();

    if (profileError) throw new ApiError(500, profileError.message);
    if (!profile) return null;

    const { data: permissions, error: permissionsError } = await supabase
      .from("page_permissions")
      .select("id,page_key,can_view,can_edit,can_delete,updated_at")
      .eq("user_id", userId)
      .order("page_key", { ascending: true });

    if (permissionsError) throw new ApiError(500, permissionsError.message);
    return mapProfile(profile as ProfileRow, (permissions ?? []) as PermissionRow[]);
  }

  static async createDeveloper(payload: {
    email:       string;
    fullName:    string;
    createdById: string;
    organizationId: string;
    permissions: PagePermissionInput[];
    password?:   string;
  }) {
    const password = payload.password ?? crypto.randomBytes(12).toString("base64url");

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: payload.email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: payload.fullName,
        role: "developer",
        organization_id: payload.organizationId,
      },
    });

    if (authError) {
      if (authError.message.toLowerCase().includes("already registered")) {
        throw new ApiError(409, "A user with this email already exists");
      }
      throw new ApiError(400, authError.message);
    }

    if (!authData.user?.id) throw new ApiError(500, "Failed to create auth user");

    const userId = authData.user.id;
    const { error: profileError } = await supabase
      .from("profiles")
      .upsert({
        id: userId,
        email: payload.email,
        full_name: payload.fullName,
        role: "developer",
        organization_id: payload.organizationId,
        created_by: payload.createdById,
        is_active: true,
      }, { onConflict: "id" });

    if (profileError) throw new ApiError(500, profileError.message);

    if (payload.permissions.length > 0) {
      await AccessService.setPagePermissions(userId, payload.permissions, payload.createdById, payload.organizationId);
    }

    const profile = await AccessService.getProfileWithPermissions(userId);
    return { profile, temp_password: password };
  }

  static async listDevelopers(callerRole: string, callerId: string, organizationId: string) {
    if (callerRole !== "admin") {
      const self = await AccessService.getProfileWithPermissions(callerId);
      return self ? [self] : [];
    }

    const { data, error } = await supabase
      .from("profiles")
      .select("id")
      .eq("role", "developer")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false });

    if (error) throw new ApiError(500, error.message);
    return Promise.all((data ?? []).map((row: { id: string }) => AccessService.getProfileWithPermissions(row.id)));
  }

  static async getDeveloper(developerId: string, organizationId?: string) {
    const profile = await AccessService.getProfileWithPermissions(developerId);
    if (!profile || profile.role !== "developer") throw new ApiError(404, "Developer not found");
    if (organizationId && profile.organizationId !== organizationId) throw new ApiError(404, "Developer not found");
    return profile;
  }

  static async toggleDeveloperStatus(developerId: string, isActive: boolean, organizationId?: string) {
    if (organizationId) await AccessService.assertUserInOrganization(developerId, organizationId);

    const { data: profile, error: fetchError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", developerId)
      .maybeSingle();

    if (fetchError) throw new ApiError(500, fetchError.message);
    if (!profile) throw new ApiError(404, "Developer not found");
    if (profile.role !== "developer") throw new ApiError(400, "Target user is not a developer");

    const { data, error } = await supabase
      .from("profiles")
      .update({ is_active: isActive })
      .eq("id", developerId)
      .select("id,email,full_name,is_active,role,organization_id")
      .single();

    if (error) throw new ApiError(500, error.message);
    return mapProfile(data as ProfileRow);
  }

  static async deleteDeveloper(developerId: string, organizationId?: string) {
    const profile = await AccessService.getDeveloper(developerId, organizationId);
    if (profile.role !== "developer") throw new ApiError(400, "Can only delete developer accounts");

    const { error } = await supabase.auth.admin.deleteUser(developerId);
    if (error) throw new ApiError(500, `Failed to delete auth user: ${error.message}`);

    return { message: "Developer deleted successfully" };
  }

  static async listAdmins(organizationId: string) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id,email,full_name,avatar_url,role,organization_id,is_active,created_at,updated_at")
      .eq("role", "admin")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true });

    if (error) throw new ApiError(500, error.message);
    return ((data ?? []) as ProfileRow[]).map((row) => mapProfile(row));
  }

  static async deleteAdmin(adminId: string, callerId: string, organizationId: string) {
    if (adminId === callerId) throw new ApiError(400, "You cannot delete your own account while logged in");

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id,role,organization_id")
      .eq("id", adminId)
      .maybeSingle();

    if (profileError) throw new ApiError(500, profileError.message);
    if (!profile || profile.organization_id !== organizationId) throw new ApiError(404, "Admin account not found");
    if (profile.role !== "admin") throw new ApiError(400, "Target account is not an admin");

    const { count, error: countError } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin")
      .eq("organization_id", organizationId);

    if (countError) throw new ApiError(500, countError.message);
    if ((count ?? 0) <= 1) throw new ApiError(400, "Cannot delete the last admin account — add another admin first");

    const { error } = await supabase.auth.admin.deleteUser(adminId);
    if (error) throw new ApiError(500, `Failed to delete auth user: ${error.message}`);

    return { message: "Admin account deleted successfully" };
  }

  static async setPagePermissions(
    userId: string,
    permissions: PagePermissionInput[],
    grantedBy: string,
    organizationId?: string
  ) {
    if (organizationId) await AccessService.assertUserInOrganization(userId, organizationId);

    const { error: deleteError } = await supabase
      .from("page_permissions")
      .delete()
      .eq("user_id", userId);

    if (deleteError) throw new ApiError(500, deleteError.message);
    if (permissions.length === 0) return [];

    const rows = permissions.map((permission) => ({
      user_id: userId,
      page_key: permission.page_key,
      can_view: permission.can_view,
      can_edit: permission.can_edit ?? false,
      can_delete: permission.can_delete ?? false,
      granted_by: grantedBy,
    }));

    const { error: insertError } = await supabase.from("page_permissions").insert(rows);
    if (insertError) throw new ApiError(500, insertError.message);

    return AccessService.getPagePermissions(userId, organizationId);
  }

  static async upsertPagePermission(
    userId: string,
    pageKey: string,
    data: { canView?: boolean; canEdit?: boolean; canDelete?: boolean },
    grantedBy: string,
    organizationId?: string
  ) {
    if (organizationId) await AccessService.assertUserInOrganization(userId, organizationId);

    const { data: row, error } = await supabase
      .from("page_permissions")
      .upsert({
        user_id: userId,
        page_key: pageKey,
        ...(data.canView !== undefined ? { can_view: data.canView } : {}),
        ...(data.canEdit !== undefined ? { can_edit: data.canEdit } : {}),
        ...(data.canDelete !== undefined ? { can_delete: data.canDelete } : {}),
        granted_by: grantedBy,
      }, { onConflict: "user_id,page_key" })
      .select("id,page_key,can_view,can_edit,can_delete,updated_at")
      .single();

    if (error) throw new ApiError(500, error.message);
    return mapPermission(row as PermissionRow);
  }

  static async getPagePermissions(userId: string, organizationId?: string) {
    if (organizationId) await AccessService.assertUserInOrganization(userId, organizationId);

    const { data, error } = await supabase
      .from("page_permissions")
      .select("id,page_key,can_view,can_edit,can_delete,updated_at")
      .eq("user_id", userId)
      .order("page_key", { ascending: true });

    if (error) throw new ApiError(500, error.message);
    return ((data ?? []) as PermissionRow[]).map(mapPermission);
  }

  static async removePagePermission(userId: string, pageKey: string, organizationId?: string) {
    if (organizationId) await AccessService.assertUserInOrganization(userId, organizationId);

    const { data: existing, error: findError } = await supabase
      .from("page_permissions")
      .select("id")
      .eq("user_id", userId)
      .eq("page_key", pageKey)
      .maybeSingle();

    if (findError) throw new ApiError(500, findError.message);
    if (!existing) throw new ApiError(404, `Permission '${pageKey}' not found for this user`);

    const { error } = await supabase
      .from("page_permissions")
      .delete()
      .eq("user_id", userId)
      .eq("page_key", pageKey);

    if (error) throw new ApiError(500, error.message);
    return { message: "Permission removed" };
  }
}