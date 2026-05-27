import type { Request, Response, NextFunction } from "express";
import { ApiError }          from "../utils/ApiError.js";
import { verifyAccessToken } from "../modules/auth/jwt.js";

/**
 * Auth middleware — verifies our custom JWT.
 *
 * ✅ Pure local verification — NO Supabase API call needed
 * ✅ Role + permissions extracted directly from JWT claims
 * ✅ Fast: just a crypto verify, no network round-trip
 *
 * Sets req.user = { id, email, role, permissions }
 */
export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      throw new ApiError(401, "Missing Authorization header. Expected: Bearer <token>");
    }

    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      throw new ApiError(401, "Access token is required");
    }

    // Verify signature + expiry — throws ApiError if invalid
    const payload = verifyAccessToken(token);

    req.user = {
      id:          payload.sub,
      email:       payload.email,
      role:        payload.role,
      permissions: payload.permissions,
    };

    next();
  } catch (err) {
    next(err);
  }
}
