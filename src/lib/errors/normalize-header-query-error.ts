import { ApiError } from "../../utils/ApiError.js";

/**
 * Map request validation (headers, query) → ApiError.  test 
 */
export function normalizeHeaderQueryError(err: unknown): ApiError | null {
  if (err instanceof Error && /Unauthorized.*User ID not found/i.test(err.message)) {
    return new ApiError(401, "User ID required. Send auth or x-user-id / userId query.", {});
  }
  return null;
}
