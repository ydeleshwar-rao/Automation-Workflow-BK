import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/ApiError.js";
import { supabase } from "../config/db.config.js";
import type { AppRole } from "../types/express.js";

const TARGET_HEADER = "x-target-user-id";

/**
 * Resolves req.targetUserId from the `x-target-user-id` header (or `target_user_id`
 * in body/query as fallback) and validates the logged-in user can access it.
 *
 *  - admin     → can target any user
 *  - developer → can target only clients listed in user_client_access
 *  - user      → can target only themselves
 *
 * If no target is provided, it defaults to the logged-in user's own id.
 *
 * Place AFTER authMiddleware.
 */
export async function resolveTargetUser(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      throw new ApiError(401, "Unauthorized");
    }

    const headerVal = req.headers[TARGET_HEADER];
    const headerId = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    const bodyId = (req.body as any)?.target_user_id;
    const queryId = req.query?.target_user_id;

    const requested =
      (typeof headerId === "string" && headerId.trim()) ||
      (typeof bodyId === "string" && bodyId.trim()) ||
      (typeof queryId === "string" && queryId.trim()) ||
      req.user.id;

    const role = (req.user.role ?? "user") as AppRole;

    if (requested === req.user.id) {
      req.targetUserId = req.user.id;
      return next();
    }

    if (role === "admin") {
      req.targetUserId = requested;
      return next();
    }

    if (role === "developer") {
      const { data, error } = await supabase
        .from("user_client_access")
        .select("client_user_id")
        .eq("user_id", req.user.id)
        .eq("client_user_id", requested)
        .maybeSingle();

      if (error) throw new ApiError(500, error.message);
      if (!data) {
        throw new ApiError(403, "You do not have access to this client");
      }
      req.targetUserId = requested;
      return next();
    }

    // role === "user" (client) cannot impersonate anyone else
    throw new ApiError(403, "Forbidden: you can only access your own data");
  } catch (err) {
    next(err);
  }
}

/** Restrict a route to one or more roles. Place AFTER authMiddleware. */
export function requireRole(...roles: AppRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role || !roles.includes(role)) {
      return next(new ApiError(403, "Forbidden: insufficient role"));
    }
    next();
  };
}

/**
 * Checks the `permissions` table for the logged-in user.
 *
 *   checkPermission("workflows", "read")
 *   checkPermission("workflows", "write")
 *
 * Admin always passes. Otherwise we look up (user_id, page) and verify
 * can_read / can_write. Place AFTER authMiddleware.
 */
export function checkPermission(page: string, action: "read" | "write" = "read") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user?.id) throw new ApiError(401, "Unauthorized");
      if (req.user.role === "admin") return next();

      if (req.user.role === "developer") {
        // Developers: check developer_permissions scoped to the target client
        const clientUserId = req.targetUserId ?? req.user.id;
        const { data, error } = await supabase
          .from("developer_permissions")
          .select("can_read, can_write")
          .eq("developer_id", req.user.id)
          .eq("client_user_id", clientUserId)
          .eq("page", page)
          .maybeSingle();

        if (error) throw new ApiError(500, error.message);
        if (!data) {
          throw new ApiError(403, `No permission configured for page "${page}"`);
        }

        const allowed = action === "write" ? data.can_write : data.can_read;
        if (!allowed) {
          throw new ApiError(403, `Missing ${action} permission for "${page}"`);
        }
        return next();
      }

      // Users: check global permissions table
      const { data, error } = await supabase
        .from("permissions")
        .select("can_read, can_write")
        .eq("user_id", req.user.id)
        .eq("page", page)
        .maybeSingle();

      if (error) throw new ApiError(500, error.message);
      if (!data) {
        throw new ApiError(403, `No permission configured for page "${page}"`);
      }

      const allowed = action === "write" ? data.can_write : data.can_read;
      if (!allowed) {
        throw new ApiError(403, `Missing ${action} permission for "${page}"`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
