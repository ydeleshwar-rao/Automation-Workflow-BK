import { supabase }                              from "../../../config/db.config.js";
import { issueTokenPair, verifyRefreshToken }   from "../jwt.js";
import type { UserRole }                        from "../jwt.js";
import { ApiError }                             from "../../../utils/ApiError.js";
import prisma                                   from "../../../lib/prisma.js";

export class AuthService {
  // ── Login ──────────────────────────────────────────────────────────────────

  /**
   * Validate credentials via Supabase auth, then issue our own custom JWT
   * with role + page permissions embedded in the token claims.
   *
   * Flow:
   *  1. supabase.auth.signInWithPassword  ← validates email/password
   *  2. fetch profile from DB             ← get role
   *  3. fetch page_permissions from DB    ← get allowed pages
   *  4. sign custom JWT pair              ← our tokens (not Supabase session)
   */
  static async login(email: string, password: string) {
    // Step 1 — validate credentials (service_role supports signInWithPassword)
    const { data: authData, error: authError } =
      await supabase.auth.signInWithPassword({ email, password });

    if (authError || !authData.user) {
      throw new ApiError(401, authError?.message ?? "Invalid email or password");
    }

    const userId = authData.user.id;

    // Step 2 — fetch profile
    const profile = await prisma.profile.findUnique({
      where: { id: userId },
      select: { id: true, email: true, fullName: true, role: true, isActive: true, avatarUrl: true },
    });

    if (!profile) {
      throw new ApiError(404, "Profile not found. Please contact an administrator.");
    }
    if (!profile.isActive) {
      throw new ApiError(403, "Your account has been deactivated. Contact an administrator.");
    }

    // Step 3 — fetch page permissions (only needed for developers)
    let permissions: string[] = [];
    if (profile.role === "developer") {
      const perms = await prisma.pagePermission.findMany({
        where:  { userId, canView: true },
        select: { pageKey: true },
      });
      permissions = perms.map((p) => p.pageKey);
    }
    // admin gets ["*"] automatically inside issueTokenPair

    // Step 4 — sign custom JWT
    const tokens = issueTokenPair({
      userId:      userId,
      email:       profile.email,
      role:        profile.role as UserRole,
      permissions,
    });

    return {
      ...tokens,
      user: {
        id:          profile.id,
        email:       profile.email,
        full_name:   profile.fullName,
        role:        profile.role,
        avatar_url:  profile.avatarUrl,
        permissions: profile.role === "admin" ? ["*"] : permissions,
      },
    };
  }

  // ── First-time Setup ───────────────────────────────────────────────────────

  /**
   * Returns true when zero admin profiles exist in the DB.
   * Used by the frontend to decide whether to show the setup banner.
   */
  static async isSetupRequired(): Promise<boolean> {
    const count = await prisma.profile.count({ where: { role: "admin" } });
    return count === 0;
  }

  /**
   * Create the FIRST admin account.
   * Throws 403 if any admin already exists (setup already done).
   *
   * Flow:
   *  1. Guard: reject if admin already exists
   *  2. supabase.auth.admin.createUser  ← creates auth user with email auto-confirmed
   *  3. upsert profile with role="admin" ← safe whether the trigger fired or not
   *  4. issue JWT pair so the admin is logged in immediately
   */
  static async setupAdmin(email: string, password: string, fullName: string) {
    // 1. Guard — only allowed when no admin exists yet
    const adminCount = await prisma.profile.count({ where: { role: "admin" } });
    if (adminCount > 0) {
      throw new ApiError(403, "Setup already completed. An admin account already exists.");
    }

    // 2. Create Supabase auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role: "admin" },
    });

    if (authError) {
      if (authError.message.toLowerCase().includes("already registered")) {
        throw new ApiError(409, "An account with this email already exists");
      }
      throw new ApiError(400, authError.message);
    }

    if (!authData.user?.id) {
      throw new ApiError(500, "Failed to create auth user");
    }

    const userId = authData.user.id;

    // 3. Upsert profile with role="admin" (safe if trigger hasn't fired yet)
    await prisma.profile.upsert({
      where:  { id: userId },
      create: { id: userId, email, fullName, role: "admin", isActive: true },
      update: { fullName, role: "admin", isActive: true },
    });

    // 4. Issue JWT so the admin lands on the dashboard immediately
    const tokens = issueTokenPair({ userId, email, role: "admin", permissions: [] });

    return {
      ...tokens,
      user: {
        id:          userId,
        email,
        full_name:   fullName,
        role:        "admin",
        avatar_url:  null,
        permissions: ["*"],
      },
    };
  }

  // ── Register ───────────────────────────────────────────────────────────────

  /**
   * Self-registration — creates a new developer account.
   *
   * Flow:
   *  1. supabase.auth.admin.createUser  ← creates auth user (email auto-confirmed)
   *  2. DB trigger creates profile row  ← we then update fullName
   *  3. Return basic profile info       ← user can log in immediately
   */
  static async register(email: string, password: string, fullName: string) {
    // Create Supabase auth user (admin API = email auto-confirmed, no email needed)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role: "developer" },
    });

    if (authError) {
      if (authError.message.toLowerCase().includes("already registered")) {
        throw new ApiError(409, "An account with this email already exists");
      }
      throw new ApiError(400, authError.message);
    }

    if (!authData.user?.id) {
      throw new ApiError(500, "Failed to create user account");
    }

    const userId = authData.user.id;

    // The DB trigger creates the profile row on auth user creation.
    // Update the full_name field since triggers often leave it blank.
    try {
      await prisma.profile.update({
        where: { id: userId },
        data:  { fullName },
      });
    } catch {
      // Trigger may not have fired yet — profile may be created async.
      // Not a hard failure; user can still log in.
    }

    return {
      user_id:   userId,
      email,
      full_name: fullName,
    };
  }

  // ── Refresh ────────────────────────────────────────────────────────────────

  /**
   * Exchange a valid refresh token for a new token pair.
   * Re-fetches permissions from DB so any permission changes take effect.
   */
  static async refreshTokens(refreshToken: string) {
    // Verify our own refresh token
    const { sub: userId } = verifyRefreshToken(refreshToken);

    // Re-fetch profile + permissions
    const profile = await prisma.profile.findUnique({
      where:  { id: userId },
      select: { id: true, email: true, fullName: true, role: true, isActive: true, avatarUrl: true },
    });

    if (!profile)      throw new ApiError(404, "User not found");
    if (!profile.isActive) throw new ApiError(403, "Account deactivated");

    let permissions: string[] = [];
    if (profile.role === "developer") {
      const perms = await prisma.pagePermission.findMany({
        where:  { userId, canView: true },
        select: { pageKey: true },
      });
      permissions = perms.map((p) => p.pageKey);
    }

    const tokens = issueTokenPair({
      userId:      userId,
      email:       profile.email,
      role:        profile.role as UserRole,
      permissions,
    });

    return {
      ...tokens,
      user: {
        id:          profile.id,
        email:       profile.email,
        full_name:   profile.fullName,
        role:        profile.role,
        avatar_url:  profile.avatarUrl,
        permissions: profile.role === "admin" ? ["*"] : permissions,
      },
    };
  }

  // ── Profile ────────────────────────────────────────────────────────────────

  /** Get full profile for the authenticated user. */
  static async getProfile(userId: string) {
    const profile = await prisma.profile.findUnique({
      where:  { id: userId },
      select: {
        id:         true,
        email:      true,
        fullName:   true,
        avatarUrl:  true,
        role:       true,
        isActive:   true,
        createdAt:  true,
        updatedAt:  true,
        pagePermissions: {
          select: { pageKey: true, canView: true, canEdit: true, canDelete: true },
        },
      },
    });

    if (!profile) throw new ApiError(404, "Profile not found");
    return profile;
  }
}
