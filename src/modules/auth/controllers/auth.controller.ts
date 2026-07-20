import { Request, Response } from "express";
import { catchAsync }    from "../../../utils/catchAsync.js";
import { ApiResponse }   from "../../../utils/ApiResponse.js";
import { ApiError }      from "../../../utils/ApiError.js";
import { AuthService }   from "../service/auth.service.js";

type AuthResult = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: unknown;
};

const isProd = process.env.NODE_ENV === "production";
const refreshMaxAgeSeconds = 7 * 24 * 60 * 60;

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds * 1000,
  };
}

function setAuthCookies(res: Response, result: AuthResult) {
  res.cookie("jm_access_token", result.access_token, cookieOptions(result.expires_in));
  res.cookie("jm_refresh_token", result.refresh_token, cookieOptions(refreshMaxAgeSeconds));
}

function clearAuthCookies(res: Response) {
  res.clearCookie("jm_access_token", { path: "/" });
  res.clearCookie("jm_refresh_token", { path: "/" });
}

function publicAuthPayload(result: AuthResult) {
  return {
    expires_in: result.expires_in,
    user: result.user,
  };
}

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

    const result = await AuthService.login(email.trim().toLowerCase(), password) as AuthResult;
    setAuthCookies(res, result);
    return ApiResponse(res, 200, "Login successful", publicAuthPayload(result));
  });

  static google = catchAsync(async (req: Request, res: Response) => {
    const { access_token } = req.body as { access_token?: string };

    if (!access_token?.trim()) {
      throw new ApiError(400, "access_token is required");
    }

    const result = await AuthService.googleLogin(access_token.trim()) as AuthResult;
    setAuthCookies(res, result);
    return ApiResponse(res, 200, "Google sign-in successful", publicAuthPayload(result));
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
    const { email, password, full_name, organization_name } = req.body as {
      email?:     string;
      password?:  string;
      full_name?: string;
      organization_name?: string;
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
      organization_name?.trim(),
    ) as AuthResult;

    setAuthCookies(res, result);
    return ApiResponse(res, 201, "Admin account created. Welcome!", publicAuthPayload(result));
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
    const cookieRefreshToken = req.headers.cookie
      ?.split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith("jm_refresh_token="))
      ?.slice("jm_refresh_token=".length);
    const refreshToken = refresh_token?.trim() || (cookieRefreshToken ? decodeURIComponent(cookieRefreshToken) : "");

    if (!refreshToken) {
      throw new ApiError(400, "refresh_token is required");
    }

    const result = await AuthService.refreshTokens(refreshToken) as AuthResult;
    setAuthCookies(res, result);
    return ApiResponse(res, 200, "Token refreshed", publicAuthPayload(result));
  });

  static logout = catchAsync(async (_req: Request, res: Response) => {
    clearAuthCookies(res);
    return ApiResponse(res, 200, "Logout successful", { loggedOut: true });
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
