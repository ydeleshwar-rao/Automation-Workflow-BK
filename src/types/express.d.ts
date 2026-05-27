import type { UserRole, AppJwtPayload } from "../modules/auth/jwt.js";

export type AppRole = UserRole; // "admin" | "developer"

declare global {
  namespace Express {
    interface Request {
      /**
       * Set by authMiddleware after verifying custom JWT.
       * Contains all claims from the token — no extra DB call needed.
       */
      user?: {
        id:          string;    // profiles.id (UUID)
        email:       string;
        role:        UserRole;
        permissions: string[];  // page keys or ['*'] for admin
      };
      /** Effective user ID the request operates on (set by resolveTargetUser middleware). */
      targetUserId?: string;
    }
  }
}

export {};
