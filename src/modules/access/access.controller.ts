import type { Request, Response } from "express";
import { catchAsync } from "../../utils/catchAsync.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { ApiError } from "../../utils/ApiError.js";
import { AccessService } from "./access.service.js";
import type { AppRole } from "../../types/express.js";

export class AccessController {
  /** GET /access/clients — list clients the logged-in user can access. */
  static listClients = catchAsync(async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const role = (req.user?.role ?? "user") as AppRole;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const data = await AccessService.listAccessibleClients(userId, role);
    return ApiResponse(res, 200, "Accessible clients", data);
  });

  /** GET /access/me — current user + role + resolved targetUserId. */
  static me = catchAsync(async (req: Request, res: Response) => {
    if (!req.user?.id) throw new ApiError(401, "Unauthorized");
    return ApiResponse(res, 200, "Current session", {
      user_id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      target_user_id: req.targetUserId ?? req.user.id,
    });
  });

  /** GET /access/users?role=developer|user|admin  (admin) */
  static listUsers = catchAsync(async (req: Request, res: Response) => {
    const roleParam = req.query.role as string | undefined;
    const allowed = ["admin", "developer", "user"] as const;
    if (roleParam && !allowed.includes(roleParam as AppRole)) {
      throw new ApiError(400, "role must be one of admin | developer | user");
    }
    const data = await AccessService.listUsersByRole(roleParam as AppRole | undefined);
    return ApiResponse(res, 200, "Users", data);
  });

  /** POST /access/assignments  (admin)  body: { developer_id, client_ids: [] } */
  static assign = catchAsync(async (req: Request, res: Response) => {
    const { developer_id, client_ids } = req.body as {
      developer_id?: string;
      client_ids?: string[];
    };
    if (!developer_id || !Array.isArray(client_ids) || !client_ids.length) {
      throw new ApiError(400, "developer_id and client_ids[] are required");
    }
    const data = await AccessService.assignClients(developer_id, client_ids);
    return ApiResponse(res, 201, "Clients assigned", data);
  });

  /**
   * DELETE /access/assignments  (admin)
   * Accepts developer_id + client_id via body OR query string
   * (some HTTP clients strip bodies from DELETE).
   */
  static revoke = catchAsync(async (req: Request, res: Response) => {
    const developer_id =
      (req.body?.developer_id as string | undefined) ??
      (req.query.developer_id as string | undefined);
    const client_id =
      (req.body?.client_id as string | undefined) ??
      (req.query.client_id as string | undefined);

    if (!developer_id || !client_id) {
      throw new ApiError(400, "developer_id and client_id are required");
    }
    const data = await AccessService.revokeClient(
      developer_id.trim(),
      client_id.trim()
    );
    return ApiResponse(res, 200, "Assignment revoked", data);
  });

  /** GET /access/assignments?developer_id=... (admin) */
  static listAssignments = catchAsync(async (req: Request, res: Response) => {
    const developerId = req.query.developer_id as string | undefined;
    const data = await AccessService.listAssignments(developerId);
    return ApiResponse(res, 200, "Assignments", data);
  });

  /** POST /access/permissions  (admin)  body: { user_id, page, can_read?, can_write? } */
  static upsertPermission = catchAsync(async (req: Request, res: Response) => {
    const { user_id, page, can_read, can_write } = req.body as {
      user_id?: string;
      page?: string;
      can_read?: boolean;
      can_write?: boolean;
    };
    if (!user_id || !page) {
      throw new ApiError(400, "user_id and page are required");
    }
    const data = await AccessService.upsertPermission({
      user_id,
      page,
      ...(typeof can_read === "boolean" ? { can_read } : {}),
      ...(typeof can_write === "boolean" ? { can_write } : {}),
    });
    return ApiResponse(res, 200, "Permission saved", data);
  });

  /** GET /access/permissions/:user_id (own permissions or admin) */
  static listPermissions = catchAsync(async (req: Request, res: Response) => {
    const userId = req.params.user_id;
    if (typeof userId !== "string" || !userId) {
      throw new ApiError(400, "user_id is required");
    }
    const callerId = req.user?.id;
    const callerRole = req.user?.role;
    if (callerRole !== "admin" && callerId !== userId) {
      throw new ApiError(403, "You can only view your own permissions");
    }
    const data = await AccessService.listPermissions(userId);
    return ApiResponse(res, 200, "Permissions", data);
  });

  /** DELETE /access/permissions  (admin)  body OR query: { user_id, page } */
  static deletePermission = catchAsync(async (req: Request, res: Response) => {
    const user_id =
      (req.body?.user_id as string | undefined) ??
      (req.query.user_id as string | undefined);
    const page =
      (req.body?.page as string | undefined) ??
      (req.query.page as string | undefined);

    if (!user_id || !page) {
      throw new ApiError(400, "user_id and page are required");
    }
    const data = await AccessService.deletePermission(user_id.trim(), page.trim());
    return ApiResponse(res, 200, "Permission removed", data);
  });

  // ── Developer-scoped permissions ──────────────────────────────────────────

  /** GET /access/developer-permissions/:developer_id/:client_user_id */
  static listDeveloperPermissions = catchAsync(async (req: Request, res: Response) => {
    const developer_id = req.params.developer_id as string;
    const client_user_id = req.params.client_user_id as string;
    if (!developer_id || !client_user_id) {
      throw new ApiError(400, "developer_id and client_user_id are required");
    }
    const callerId = req.user?.id;
    const callerRole = req.user?.role;
    if (callerRole !== "admin" && callerId !== developer_id) {
      throw new ApiError(403, "You can only view your own developer permissions");
    }
    const data = await AccessService.listDeveloperPermissions(developer_id, client_user_id);
    return ApiResponse(res, 200, "Developer permissions", data);
  });

  /** POST /access/developer-permissions  (admin) */
  static upsertDeveloperPermission = catchAsync(async (req: Request, res: Response) => {
    const { developer_id, client_user_id, page, can_read, can_write } = req.body as {
      developer_id?: string;
      client_user_id?: string;
      page?: string;
      can_read?: boolean;
      can_write?: boolean;
    };
    if (!developer_id || !client_user_id || !page) {
      throw new ApiError(400, "developer_id, client_user_id, and page are required");
    }
    const data = await AccessService.upsertDeveloperPermission({
      developer_id,
      client_user_id,
      page,
      ...(typeof can_read === "boolean" ? { can_read } : {}),
      ...(typeof can_write === "boolean" ? { can_write } : {}),
    });
    return ApiResponse(res, 200, "Developer permission saved", data);
  });

  /** DELETE /access/developer-permissions  (admin) */
  static deleteDeveloperPermission = catchAsync(async (req: Request, res: Response) => {
    const developer_id =
      (req.body?.developer_id as string | undefined) ??
      (req.query.developer_id as string | undefined);
    const client_user_id =
      (req.body?.client_user_id as string | undefined) ??
      (req.query.client_user_id as string | undefined);
    const page =
      (req.body?.page as string | undefined) ??
      (req.query.page as string | undefined);

    if (!developer_id || !client_user_id || !page) {
      throw new ApiError(400, "developer_id, client_user_id, and page are required");
    }
    const data = await AccessService.deleteDeveloperPermission(
      developer_id.trim(),
      client_user_id.trim(),
      page.trim(),
    );
    return ApiResponse(res, 200, "Developer permission removed", data);
  });
}
