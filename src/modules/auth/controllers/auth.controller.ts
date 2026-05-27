import { Request, Response } from "express";
import { catchAsync }    from "../../../utils/catchAsync.js";
import { ApiResponse }   from "../../../utils/ApiResponse.js";
import { ApiError }      from "../../../utils/ApiError.js";
import { AuthService }   from "../service/auth.service.js";

export class AuthController {
  /**
   * POST /auth/login
   * Body: { email, password }
   * Returns: { access_token, refresh_token, expires_in, user: { id, email, role, permissions } }
   */
  static login = catchAsync(async (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email?.trim() || !password) {
      throw new ApiError(400, "email and password are required");
    }

    const result = await AuthService.login(email.trim().toLowerCase(), password);
    return ApiResponse(res, 200, "Login successful", result);
  });

  /**
   * GET /auth/setup/status
   * Returns { setupRequired: true } when no admin exists yet.
   * Used by the frontend to show the first-time setup banner.
   */
  static setupStatus = catchAsync(async (_req: Request, res: Response) => {
    const setupRequired = await AuthService.isSetupRequired();
    return ApiResponse(res, 200, "Setup status", { setupRequired });
  });

  /**
   * POST /auth/setup
   * Body: { email, password, full_name }
   * Creates the FIRST admin account and returns a JWT so the admin is
   * logged in immediately. Returns 403 if an admin already exists.
   */
  static setup = catchAsync(async (req: Request, res: Response) => {
    const { email, password, full_name } = req.body as {
      email?:     string;
      password?:  string;
      full_name?: string;
    };

    if (!email?.trim())     throw new ApiError(400, "email is required");
    if (!full_name?.trim()) throw new ApiError(400, "full_name is required");
    if (!password || password.length < 8) {
      throw new ApiError(400, "password must be at least 8 characters");
    }

    const result = await AuthService.setupAdmin(
      email.trim().toLowerCase(),
      password,
      full_name.trim(),
    );

    return ApiResponse(res, 201, "Admin account created. Welcome!", result);
  });

  /**
   * POST /auth/register
   * Body: { email, password, full_name }
   * Creates a new developer account and returns basic profile data.
   * The user can log in immediately after registration.
   */
  static register = catchAsync(async (req: Request, res: Response) => {
    const { email, password, full_name } = req.body as {
      email?:     string;
      password?:  string;
      full_name?: string;
    };

    if (!email?.trim())          throw new ApiError(400, "email is required");
    if (!full_name?.trim())      throw new ApiError(400, "full_name is required");
    if (!password || password.length < 8) {
      throw new ApiError(400, "password must be at least 8 characters");
    }

    const result = await AuthService.register(
      email.trim().toLowerCase(),
      password,
      full_name.trim(),
    );

    return ApiResponse(res, 201, "Account created successfully", result);
  });

  /**
   * POST /auth/refresh
   * Body: { refresh_token }
   * Returns: new token pair with fresh permissions from DB
   */
  static refresh = catchAsync(async (req: Request, res: Response) => {
    const { refresh_token } = req.body as { refresh_token?: string };

    if (!refresh_token?.trim()) {
      throw new ApiError(400, "refresh_token is required");
    }

    const result = await AuthService.refreshTokens(refresh_token.trim());
    return ApiResponse(res, 200, "Token refreshed", result);
  });

  /**
   * GET /auth/profile  (requires authMiddleware)
   * Returns full profile + page permissions for the authenticated user
   */
  static getProfile = catchAsync(async (req: Request, res: Response) => {
    if (!req.user?.id) throw new ApiError(401, "Unauthorized");

    const profile = await AuthService.getProfile(req.user.id);
    return ApiResponse(res, 200, "Profile fetched", { profile });
  });
}
