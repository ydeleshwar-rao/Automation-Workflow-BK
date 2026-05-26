import { Request, Response, NextFunction } from "express";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import { getPublicKeyPem } from "../../../../utils/smtp-crypto.util.js";
import {
  createSmtpConnection,
  sendAndSaveEmail,
  getEmailLogs,
  getConnectionsService,
} from "../service/mail.service.js";

/** GET /mail/public-key — browser fetches this to encrypt credentials before transit */
export async function getPublicKeyController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const publicKey = getPublicKeyPem();
    return ApiResponse(res, 200, "Public key fetched", { publicKey });
  } catch (error) {
    next(error);
  }
}

export async function createSmtpConnectionController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // created_by comes from the verified auth token — never trust the client body
    const result = await createSmtpConnection({ ...req.body, created_by: req.user!.id });
    return ApiResponse(res, 200, "SMTP connected successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function sendEmailController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // user_id from auth token — client cannot spoof this
    const result = await sendAndSaveEmail({ ...req.body, user_id: req.user!.id });
    return ApiResponse(res, 200, "Email processed", result);
  } catch (error) {
    next(error);
  }
}

export async function getEmailLogsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await getEmailLogs(req.user!.id);
    return ApiResponse(res, 200, "Logs fetched", result);
  } catch (error) {
    next(error);
  }
}

export async function getConnectionsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await getConnectionsService();
    return ApiResponse(res, 200, "Connections fetched", result);
  } catch (error) {
    next(error);
  }
}
