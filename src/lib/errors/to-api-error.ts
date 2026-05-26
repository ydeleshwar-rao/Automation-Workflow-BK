import { ApiError } from "../../utils/ApiError.js";
import { normalizeDatabaseError } from "./normalize-database-error.js";
import { normalizeHeaderQueryError } from "./normalize-header-query-error.js";
import { normalizeHttpResponseError } from "./normalize-http-response-error.js";
import { normalizeJwtError } from "./normalize-jwt-error.js";

type ErrWithExtras = Error & {
  statusCode?: number;
  errors?: unknown[];
};

/**
 * Turn any thrown value into ApiError using normalizers (stubs until implemented).
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  // Check HTTP/axios errors before DB errors — axios errors have a `message`
  // property that fools the postgrest-like check in normalizeDatabaseError.
  const fromHttp = normalizeHttpResponseError(err);
  if (fromHttp) return fromHttp;

  const fromDb = normalizeDatabaseError(err);
  if (fromDb) return fromDb;

  const fromReq = normalizeHeaderQueryError(err);
  if (fromReq) return fromReq;

  const fromJwt = normalizeJwtError(err);
  if (fromJwt) return fromJwt;

  const e = err as ErrWithExtras;
  const statusCode = e.statusCode ?? 500;
  const message =
    typeof e?.message === "string" && e.message
      ? e.message
      : "Internal Server Error";
  return new ApiError(
    statusCode,
    message,
    {
    errors: Array.isArray(e.errors) ? e.errors : [],
    cause: err
  }
  );
}
