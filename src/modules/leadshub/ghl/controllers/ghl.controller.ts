import { Request, Response, NextFunction } from "express";
import * as ghlService from "../service/ghl.service.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import { getUserId } from "../../../../common/function.js";

export const ghlInstallController = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const installUrl = await ghlService.ghlInstallService(req);
    return ApiResponse(res, 200, "GHL install URL generated", { url: installUrl });
  } catch (error: any) {
    if (error?.statusCode === 409) {
      return ApiResponse(res, 409, "Already connected to LeadsHub", null);
    }
    next(error);
  }
};

export const ghlCallbackController = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    await ghlService.ghlCallbackService(req);
    // return res.send(`
    //   <script>
    //     window.opener.postMessage({ type: "GHL_CONNECT_SUCCESS" }, "*");
    //     window.close();
    //   </script>
    // `);
    return res.send(`<!DOCTYPE html><html><body><script>window.close();</script><p>Connected successfully. You may close this window.</p></body></html>`)
  } catch (error) {
    next(error);
  }
};


export const ghlDisconnectController = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = await getUserId(req);
    await ghlService.ghlDisconnectService(userId);

    return ApiResponse(res, 200, "GHL Disconnected Successfully", null);
  } catch (error) {
    next(error);
  }
};


export const ghlStatusController = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = await getUserId(req);
    const status = await ghlService.ghlStatusService(userId);

    return ApiResponse(res, 200, "Status fetched", status);
  } catch (error) {
    next(error);
  }
};
