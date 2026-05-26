import { Request, Response } from "express";
import { catchAsync } from "../../../utils/catchAsync.js";
import { ApiResponse } from "../../../utils/ApiResponse.js";
import { supabase } from "../../../config/db.config.js";
import { ApiError } from "../../../utils/ApiError.js";
import { issueTokenPair } from "../jwt.js";
import { AuthService } from "../service/auth.service.js";


export class AuthController {
  /**
   * POST /auth/login — Supabase email/password → app JWTs
   */
  static login = catchAsync(async (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email?.trim() || !password) {
      throw new ApiError(400, "email and password are required");
    }
    const result = await AuthService.generateAccessToken(email.trim(), password);

    return ApiResponse(res, 200, "Login successful", result);
  });

  /**
   * POST /auth/register — create user (service role)
   */
  static register = catchAsync(async (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email?.trim() || !password || password.length < 6) {
      throw new ApiError(
        400,
        "email and password (min 6 chars) are required"
      );
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email: email.trim(),
      password,
      email_confirm: true,
    });

    if (error) {
      throw new ApiError(400, error.message);
    }
    if (!data.user?.id) {
      throw new ApiError(500, "Registration failed");
    }

    const tokens = issueTokenPair(data.user.id, data.user.email ?? undefined);
    return ApiResponse(res, 201, "User registered", {
      user_id: data.user.id,
      email: data.user.email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    });
  });

  /**
   * POST /auth/session/refresh — exchange Supabase refresh token for a fresh session.
   * Returns the same shape as /auth/login so the frontend can persist it identically.
   */
  static sessionRefresh = catchAsync(async (req: Request, res: Response) => {
    const { refresh_token } = req.body as { refresh_token?: string };
    if (!refresh_token?.trim()) {
      throw new ApiError(400, "refresh_token is required");
    }

    const result = await AuthService.refreshSession(refresh_token.trim());
    return ApiResponse(res, 200, "Session refreshed", result);
  });

    /**
     * GET /profile — fetch the authenticated user's profile
     */
    static getProfile = catchAsync(async (req: Request, res: Response) => {
      const user = req.user;
      if (!user?.id) {
        throw new ApiError(401, "Unauthorized");
      }
  
      const profile = await AuthService.getProfile(user.id);
  
      return ApiResponse(res, 200, "Profile fetched successfully", { profile });
    });
 
}
