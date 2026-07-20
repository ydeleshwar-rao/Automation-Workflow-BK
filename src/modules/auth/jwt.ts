import jwt from "jsonwebtoken";
import { ApiError } from "../../utils/ApiError.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type JwtTyp    = "access" | "refresh";
export type UserRole  = "admin" | "developer";

/**
 * Custom JWT payload — signed by this backend, verified by this backend.
 * No Supabase session tokens are passed to the frontend.
 *
 * permissions:
 *   - admin     → ["*"]  (wildcard, all pages)
 *   - developer → ["dashboard", "workflow", ...] (only granted pages)
 */
export interface AppJwtPayload {
  sub:         string;       // profiles.id (UUID)
  email:       string;
  role:        UserRole;
  organization_id: string;
  permissions: string[];     // page keys or ["*"] for admin
  typ:         JwtTyp;
  iat?:        number;
  exp?:        number;
}

export interface TokenPair {
  access_token:  string;
  refresh_token: string;
  expires_in:    number;     // seconds until access token expires
}

// ─── Page Keys ────────────────────────────────────────────────────────────────

export const PAGE_KEYS = {
  DASHBOARD:    "dashboard",
  WORKFLOW:     "workflow",
  ASSETS:       "assets",
  INTEGRATIONS: "integrations",
  ANALYTICS:    "analytics",
} as const;

export type PageKey = (typeof PAGE_KEYS)[keyof typeof PAGE_KEYS];

/** Admin gets wildcard — access to all pages automatically. */
export const ADMIN_PERMISSIONS = ["*"] as const;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function accessSecret(): string {
  const s = process.env.JWT_ACCESS_SECRET;
  if (!s?.length) throw new ApiError(500, "JWT_ACCESS_SECRET is not configured");
  return s;
}

function refreshSecret(): string {
  const s = process.env.JWT_REFRESH_SECRET;
  if (!s?.length) throw new ApiError(500, "JWT_REFRESH_SECRET is not configured");
  return s;
}

function expiresSeconds(spec: string): number {
  const m = /^(\d+)\s*([smhd])$/i.exec(spec.trim());
  if (!m) return 900; // default 15 min
  const n = parseInt(m[1]!, 10);
  const u = m[2]!.toLowerCase();
  if (u === "s") return n;
  if (u === "m") return n * 60;
  if (u === "h") return n * 3600;
  return n * 86400;
}

// ─── Token issuing ────────────────────────────────────────────────────────────

/**
 * Issue access + refresh token pair.
 * Admin always gets ["*"] regardless of what permissions array is passed.
 */
export function issueTokenPair(payload: {
  userId:      string;
  email:       string;
  role:        UserRole;
  organizationId: string;
  permissions: string[];
}): TokenPair {
  const accessExpirySpec  = process.env.JWT_ACCESS_EXPIRES  ?? "15m";
  const refreshExpirySpec = process.env.JWT_REFRESH_EXPIRES ?? "7d";

  const accessPayload: Omit<AppJwtPayload, "iat" | "exp"> = {
    sub:         payload.userId,
    email:       payload.email,
    role:        payload.role,
    organization_id: payload.organizationId,
    permissions: payload.role === "admin" ? ["*"] : payload.permissions,
    typ:         "access",
  };

  const refreshPayload = {
    sub: payload.userId,
    typ: "refresh" as const,
  };

  const access_token  = jwt.sign(accessPayload,  accessSecret(),  { expiresIn: expiresSeconds(accessExpirySpec)  });
  const refresh_token = jwt.sign(refreshPayload, refreshSecret(), { expiresIn: expiresSeconds(refreshExpirySpec) });

  return {
    access_token,
    refresh_token,
    expires_in: expiresSeconds(accessExpirySpec),
  };
}

// ─── Token verification ───────────────────────────────────────────────────────

/** Verify access token — throws ApiError if invalid or expired. */
export function verifyAccessToken(token: string): AppJwtPayload {
  try {
    const decoded = jwt.verify(token, accessSecret()) as AppJwtPayload;
    if (decoded.typ !== "access") {
      throw new ApiError(401, "Invalid token type: expected access token");
    }
    if (!decoded.sub) {
      throw new ApiError(401, "Invalid token: missing subject");
    }
    return decoded;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(401, "Invalid or expired access token");
  }
}

/** Verify refresh token — returns user_id. Throws ApiError if invalid. */
export function verifyRefreshToken(token: string): { sub: string } {
  try {
    const decoded = jwt.verify(token, refreshSecret()) as AppJwtPayload;
    if (decoded.typ !== "refresh") {
      throw new ApiError(401, "Invalid token type: expected refresh token");
    }
    if (!decoded.sub) {
      throw new ApiError(401, "Invalid token: missing subject");
    }
    return { sub: decoded.sub };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(401, "Invalid or expired refresh token");
  }
}

// ─── Permission helpers ───────────────────────────────────────────────────────

/** Check if a decoded JWT payload grants view access to a page. */
export function hasPageAccess(payload: AppJwtPayload, pageKey: string): boolean {
  if (payload.role === "admin")               return true;
  if (payload.permissions.includes("*"))      return true;
  return payload.permissions.includes(pageKey);
}
