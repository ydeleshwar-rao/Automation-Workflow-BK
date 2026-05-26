import axios from "axios";
import { ApiError } from "../../utils/ApiError.js";
/**
 * Map outbound HTTP failures (status codes, axios/fetch errors) → ApiError.
 * Stub: implement response.status, response.data parsing, etc.
 */



export function normalizeHttpResponseError(err: unknown): ApiError | null {
  if (!axios.isAxiosError(err)) return null;

  const status = err.response?.status ?? 500;
  const responseData = err.response?.data;

  const message =
    responseData?.message ||
    responseData?.error ||
    err.message ||
    "External API error";

  const meta: Record<string, unknown> = {
    externalUrl: err.config?.url,
    externalMethod: err.config?.method?.toUpperCase(),
    externalStatus: err.response?.status,
    externalStatusText: err.response?.statusText,
    ...(process.env.NODE_ENV !== "production" && { externalResponseBody: responseData }),
  };

  return new ApiError(status, message, { meta });
}