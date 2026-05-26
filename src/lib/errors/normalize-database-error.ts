import { ApiError } from "../../utils/ApiError.js";

/** Supabase Postgrest / GoTrue style error */
function isPostgrestLike(err: unknown): err is { message: string; code?: string; details?: string; hint?: string } {
  if (!err || typeof err !== "object") return false;
  const o = err as Record<string, unknown>;
  return typeof o.message === "string" && o.message.length > 0;
}

/**
 * Map DB / ORM errors (e.g. Supabase PostgREST) → ApiError.
 */
export function normalizeDatabaseError(err: unknown): ApiError | null {
  if (!isPostgrestLike(err)) return null;

  const code = typeof err.code === "string" ? err.code : "";
  const message = err.message;
  const extras = [err.details, err.hint].filter((x): x is string => typeof x === "string" && x.length > 0);

  if (code === "PGRST301" || /jwt|expired|not authorized/i.test(message)) {
    return new ApiError(401, message, { errors: extras });
  }
  if (code === "PGRST116") {
    return new ApiError(404, message, { errors: extras });
  }
  if (/connection|timeout|econnrefused/i.test(message)) {
    return new ApiError(503, message, { errors: extras });
  }

  return new ApiError(500, message, { errors: extras });
}
