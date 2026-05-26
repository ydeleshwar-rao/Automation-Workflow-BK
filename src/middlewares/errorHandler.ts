import type { ErrorRequestHandler } from "express";
import { toApiError } from "../lib/errors/to-api-error.js";

import { logger } from "../utils/logger.js";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const apiErr = toApiError(err);

  const { statusCode, message, errors } = apiErr;

  logger.error("API ERROR", {
    statusCode,
    message,
    path: req.originalUrl,
    method: req.method,
    query: req.query,
    params: req.params,
    headers: req.headers,
    body: req.body,
    meta: apiErr.meta,
    stack: apiErr.stack,
  });

  if (process.env.NODE_ENV !== "production" && apiErr.meta?.externalStatus) {
    logger.error("EXTERNAL API ERROR", {
      url: apiErr.meta.externalUrl,
      method: apiErr.meta.externalMethod,
      status: apiErr.meta.externalStatus,
      statusText: apiErr.meta.externalStatusText,
      responseBody: apiErr.meta.externalResponseBody,
    });
  }

  const response: Record<string, unknown> = {
    success: false,
    message,
  };

  if (process.env.NODE_ENV !== "production") {
    response.errors = errors;
    response.code = apiErr.code;
  }

  res.status(statusCode).json(response);
};