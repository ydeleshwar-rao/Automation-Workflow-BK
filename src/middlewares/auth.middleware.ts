import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/ApiError.js";
import { supabase } from "../config/db.config.js";
import { verifyAccessToken, verifyRefreshToken } from "../modules/auth/jwt.js";

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

async function userFromRefreshToken(refreshToken: string) {
  const { sub: userId } = verifyRefreshToken(refreshToken);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id,email,role,organization_id,is_active")
    .eq("id", userId)
    .maybeSingle();

  if (profileError) throw new ApiError(500, profileError.message);
  if (!profile || profile.is_active === false) {
    throw new ApiError(401, "User is inactive or not found");
  }

  const { data: permissions, error: permissionsError } = await supabase
    .from("page_permissions")
    .select("page_key,can_view")
    .eq("user_id", userId)
    .eq("can_view", true);

  if (permissionsError) throw new ApiError(500, permissionsError.message);

  return {
    id: profile.id,
    email: profile.email,
    role: profile.role,
    organizationId: profile.organization_id,
    permissions: profile.role === "admin" ? ["*"] : (permissions ?? []).map((permission) => permission.page_key),
  };
}

/**
 * Auth middleware verifies the backend JWT. If the short-lived access cookie is
 * missing or expired, a valid refresh cookie can still hydrate req.user so
 * background status checks do not fail before the client refresh interceptor runs.
 */
export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const cookieToken = readCookie(req.headers.cookie, "jm_access_token");
    const refreshToken = readCookie(req.headers.cookie, "jm_refresh_token");
    const headerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.replace(/^Bearer\s+/i, "").trim()
      : null;
    const token = cookieToken || headerToken;

    if (!token) {
      if (!refreshToken) throw new ApiError(401, "Access token is required");
      req.user = await userFromRefreshToken(refreshToken);
      next();
      return;
    }

    try {
      const payload = verifyAccessToken(token);
      req.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        organizationId: payload.organization_id,
        permissions: payload.permissions,
      };
      next();
      return;
    } catch (err) {
      if (!refreshToken) throw err;
      req.user = await userFromRefreshToken(refreshToken);
      next();
      return;
    }
  } catch (err) {
    next(err);
  }
}