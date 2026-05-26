import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/ApiError.js";
import { supabase } from "../config/db.config.js";
import type { AppRole } from "../types/express.js";

/**
 * Verifies Supabase access JWT (Authorization: Bearer <access_token>).
 * Sets req.user.id, req.user.email, and req.user.role from the profiles table.
 */
export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      throw new ApiError(
        401,
        "Missing or invalid Authorization header. Send: Bearer <access_token>"
      );
    }

    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      throw new ApiError(401, "Access token is required");
    }

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      throw new ApiError(401, "Invalid or expired access token");
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", data.user.id)
      .single();

    const role = (profile?.role as AppRole | undefined) ?? "user";

    req.user = {
      id: data.user.id,
      ...(data.user.email && { email: data.user.email }),
      role,
    };

    next();
  } catch (err) {
    next(err);
  }
}
