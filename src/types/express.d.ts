export type AppRole = "admin" | "developer" | "user";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email?: string;
        role?: AppRole;
      };
      /** Effective user ID the request operates on (set by resolveTargetUser middleware). */
      targetUserId?: string;
    }
  }
}

export {};
