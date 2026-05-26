import { supabase } from "../../config/db.config.js";
import { ApiError } from "../../utils/ApiError.js";
import type { AppRole } from "../../types/express.js";

export class AccessService {
  /**
   * Clients (profiles with role='user') the caller can access.
   *  - admin     → all clients
   *  - developer → only clients in user_client_access
   *  - user      → just self
   */
  static async listAccessibleClients(userId: string, role: AppRole) {
    if (role === "admin") {
      const { data, error } = await supabase
        .from("profiles")
        .select(
          "id, first_name, last_name, email, company_name, clientkey, role, avatar_url"
        )
        .eq("role", "user")
        .order("first_name", { ascending: true });
      if (error) throw new ApiError(500, error.message);
      return data ?? [];
    }

    if (role === "developer") {
      const { data, error } = await supabase
        .from("user_client_access")
        .select(
          "client_user_id, profiles:client_user_id (id, first_name, last_name, email, company_name, clientkey, role, avatar_url)"
        )
        .eq("user_id", userId);
      if (error) throw new ApiError(500, error.message);
      return (data ?? [])
        .map((row: any) => row.profiles)
        .filter(Boolean);
    }

    // role === "user" → self only
    const { data, error } = await supabase
      .from("profiles")
      .select(
        "id, first_name, last_name, email, company_name, clientkey, role, avatar_url"
      )
      .eq("id", userId)
      .single();
    if (error) throw new ApiError(404, "Profile not found");
    return data ? [data] : [];
  }

  /** Admin: list profiles, optionally filtered by role. */
  static async listUsersByRole(role?: AppRole) {
    let q = supabase
      .from("profiles")
      .select(
        "id, first_name, last_name, email, phone, company_name, clientkey, role, avatar_url, created_at"
      )
      .order("first_name", { ascending: true });
    if (role) q = q.eq("role", role);
    const { data, error } = await q;
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  /** Admin: assign one or more clients to a developer. */
  static async assignClients(developerId: string, clientIds: string[]) {
    if (!clientIds.length) return [];

    const { data: dev, error: devErr } = await supabase
      .from("profiles")
      .select("id, role")
      .eq("id", developerId)
      .single();
    if (devErr || !dev) throw new ApiError(404, "Developer profile not found");
    if (dev.role !== "developer" && dev.role !== "admin") {
      throw new ApiError(400, "Target user is not a developer/admin");
    }

    const rows = clientIds.map((cid) => ({
      user_id: developerId,
      client_user_id: cid,
    }));

    const { data, error } = await supabase
      .from("user_client_access")
      .upsert(rows, { onConflict: "user_id,client_user_id" })
      .select();

    if (error) throw new ApiError(500, error.message);
    return data;
  }

  /** Admin: revoke a single developer↔client mapping. Also cleans up developer_permissions. */
  static async revokeClient(developerId: string, clientId: string) {
    const { data, error } = await supabase
      .from("user_client_access")
      .delete()
      .eq("user_id", developerId)
      .eq("client_user_id", clientId)
      .select();
    if (error) throw new ApiError(500, error.message);
    if (!data || data.length === 0) {
      throw new ApiError(
        404,
        "No matching assignment found for this developer/client pair"
      );
    }

    // Clean up developer_permissions for this pair
    await supabase
      .from("developer_permissions")
      .delete()
      .eq("developer_id", developerId)
      .eq("client_user_id", clientId);

    return { message: "Access revoked", deleted: data };
  }

  /** Admin: list all developer↔client mappings (optionally filtered). */
  static async listAssignments(developerId?: string) {
    let query = supabase
      .from("user_client_access")
      .select(
        "id, created_at, user_id, client_user_id, " +
          "developer:user_id (id, first_name, last_name, email, role), " +
          "client:client_user_id (id, first_name, last_name, email, role)"
      )
      .order("created_at", { ascending: false });

    if (developerId) query = query.eq("user_id", developerId);

    const { data, error } = await query;
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  /** Admin: upsert a (user, page) permission row. */
  static async upsertPermission(payload: {
    user_id: string;
    page: string;
    can_read?: boolean;
    can_write?: boolean;
  }) {
    const { data, error } = await supabase
      .from("permissions")
      .upsert(
        {
          user_id: payload.user_id,
          page: payload.page,
          can_read: payload.can_read ?? true,
          can_write: payload.can_write ?? false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,page" }
      )
      .select()
      .single();
    if (error) throw new ApiError(500, error.message);
    return data;
  }

  /** List permissions for a given user. */
  static async listPermissions(userId: string) {
    const { data, error } = await supabase
      .from("permissions")
      .select("id, user_id, page, can_read, can_write, created_at, updated_at")
      .eq("user_id", userId)
      .order("page", { ascending: true });
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  /** Admin: delete a permission row. */
  static async deletePermission(userId: string, page: string) {
    const { data, error } = await supabase
      .from("permissions")
      .delete()
      .eq("user_id", userId)
      .eq("page", page)
      .select();
    if (error) throw new ApiError(500, error.message);
    if (!data || data.length === 0) {
      throw new ApiError(404, "No matching permission found");
    }
    return { message: "Permission removed", deleted: data };
  }

  // ── Developer-scoped permissions ──────────────────────────────────────────

  /** List developer permissions for a specific developer + client pair. */
  static async listDeveloperPermissions(developerId: string, clientUserId: string) {
    const { data, error } = await supabase
      .from("developer_permissions")
      .select("id, developer_id, client_user_id, page, can_read, can_write, created_at, updated_at")
      .eq("developer_id", developerId)
      .eq("client_user_id", clientUserId)
      .order("page", { ascending: true });
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  /** Admin: upsert a developer permission row. */
  static async upsertDeveloperPermission(payload: {
    developer_id: string;
    client_user_id: string;
    page: string;
    can_read?: boolean;
    can_write?: boolean;
  }) {
    const { data, error } = await supabase
      .from("developer_permissions")
      .upsert(
        {
          developer_id: payload.developer_id,
          client_user_id: payload.client_user_id,
          page: payload.page,
          can_read: payload.can_read ?? true,
          can_write: payload.can_write ?? false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "developer_id,client_user_id,page" }
      )
      .select()
      .single();
    if (error) throw new ApiError(500, error.message);
    return data;
  }

  /** Admin: delete a developer permission row. */
  static async deleteDeveloperPermission(developerId: string, clientUserId: string, page: string) {
    const { data, error } = await supabase
      .from("developer_permissions")
      .delete()
      .eq("developer_id", developerId)
      .eq("client_user_id", clientUserId)
      .eq("page", page)
      .select();
    if (error) throw new ApiError(500, error.message);
    if (!data || data.length === 0) {
      throw new ApiError(404, "No matching developer permission found");
    }
    return { message: "Permission removed", deleted: data };
  }
}
