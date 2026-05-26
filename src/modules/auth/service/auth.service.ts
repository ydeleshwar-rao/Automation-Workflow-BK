import { supabase, supabaseAnon } from "../../../config/db.config.js";
import { ApiError } from "../../../utils/ApiError.js";

export class AuthService {
  /**
   * Signs in with email/password via Supabase and returns the session tokens.
   */
  static async generateAccessToken(email: string, password: string) {
    if (!supabaseAnon) {
      throw new ApiError(500, "SUPABASE_ANON_KEY is not configured");
    }

    const { data, error } = await supabaseAnon.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      throw new ApiError(401, error.message || "Invalid email or password");
    }

    const { session, user } = data;
    if (!session || !user) {
      throw new ApiError(401, "Login failed");
    }

    return {
      user_id: user.id,
      email: user.email,

      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
    };
  }

  /**
   * Exchanges a Supabase refresh token for a fresh session.
   * Must use Supabase's own refresh flow because the auth middleware
   * verifies access tokens via supabase.auth.getUser().
   */
  static async refreshSession(refreshToken: string) {
    if (!supabaseAnon) {
      throw new ApiError(500, "SUPABASE_ANON_KEY is not configured");
    }

    const { data, error } = await supabaseAnon.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.session || !data.user) {
      throw new ApiError(401, error?.message || "Invalid or expired refresh token");
    }

    const { session, user } = data;
    return {
      user_id: user.id,
      email: user.email,
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
    };
  }

   static async getProfile(userId: string) {
      const { data: profile, error } = await supabase
        .from("profiles")
        .select("id, first_name, last_name, email, phone, company_name, role, created_at, updated_at, clientkey, job_app_type, avatar_url, website_url")
        .eq("id", userId)
        .single();
  
      if (error) {
        throw new ApiError(404, "Profile not found");
      }
  
      return profile;
    }
}
