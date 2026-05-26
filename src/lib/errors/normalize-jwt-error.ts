import type { JsonWebTokenError, TokenExpiredError } from "jsonwebtoken";
import { ApiError } from "../../utils/ApiError.js";

function isJwtLibError(err: unknown): err is JsonWebTokenError | TokenExpiredError {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    typeof (err as { name?: string }).name === "string"
  );
}

/**
 * Map jsonwebtoken errors → ApiError for consistent API responses.
 */
export function normalizeJwtError(err: unknown): ApiError | null {
  if (!isJwtLibError(err)) return null;
  const name = err.name;
  if (name === "TokenExpiredError") {
    return new ApiError(401, "Token expired");
  }
  if (name === "JsonWebTokenError") {
    return new ApiError(401, err.message || "Invalid token");
  }
  if (name === "NotBeforeError") {
    return new ApiError(401, "Token not active yet");
  }
  return null;
}
