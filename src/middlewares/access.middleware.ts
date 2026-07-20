import type { Request, Response, NextFunction } from "express";
import { ApiError }      from "../utils/ApiError.js";
import { hasPageAccess } from "../modules/auth/jwt.js";
import type { AppRole }  from "../types/express.js";

/**
 * Restrict a route to specific roles.
 *
 * Usage:  router.post("/...", authMiddleware, requireRole("admin"), handler)
 */
export function requireRole(...roles: AppRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (!role || !roles.includes(role as AppRole)) {
      next(new ApiError(403, `Forbidden: requires role ${roles.join(" or ")}`));
      return;
    }
    next();
  };
}

/**
 * Restrict a route to users who have view access to a specific page.
 *
 * - Admin:     always passes (permissions: ["*"])
 * - Developer: passes only if page_key is in their JWT permissions[]
 *
 * Usage:  router.get("/workflow", authMiddleware, requirePage("workflow"), handler)
 *
 * NOTE: This reads from the JWT — no DB call needed.
 *       Permissions are refreshed on token refresh.
 */
export function requirePage(pageKey: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new ApiError(401, "Unauthorized"));
      return;
    }

    const granted = hasPageAccess(
      {
        sub:         req.user.id,
        email:       req.user.email,
        role:        req.user.role,
        organization_id: req.user.organizationId,
        permissions: req.user.permissions,
        typ:         "access",
      },
      pageKey
    );

    if (!granted) {
      next(new ApiError(403, `Access denied to page: ${pageKey}`));
      return;
    }

    next();
  };
}

/**
 * resolveTargetUser — simplified version.
 * Sets req.targetUserId = req.user.id (self only).
 * Admin can override via x-target-user-id header.
 *
 * NOTE: With the new architecture (no client concept), developers only
 * access their own data. This middleware is kept for compatibility.
 */
export function resolveTargetUser(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.user?.id) {
    next(new ApiError(401, "Unauthorized"));
    return;
  }

  if (req.user.role === "admin") {
    const headerVal = req.headers["x-target-user-id"];
    const headerId  = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    req.targetUserId = (typeof headerId === "string" && headerId.trim()) || req.user.id;
  } else {
    // Non-admin always resolves to self
    req.targetUserId = req.user.id;
  }

  next();
}
