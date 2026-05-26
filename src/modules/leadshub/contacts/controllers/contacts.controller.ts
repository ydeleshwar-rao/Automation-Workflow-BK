import { Request, Response, NextFunction } from "express";
import * as contactService from "../service/contacts.service.js";
import { getLocationIdByUserId, getUserId } from "../../../../common/function.js";

export const syncContactsController = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { locationId } = req.params;

    if (!locationId || typeof locationId !== 'string') {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing locationId parameter",
      });
    }

    const data = await contactService.syncContacts(locationId);

    res.status(200).json({
      success: true,
      message: "Contacts synced successfully",
      data,
    });
  } catch (error) {
    next(error);
  }
};


export const createContactController = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    console.log("🚀 Incoming request to create contact with body:", JSON.stringify(req.body, null, 2));
      const userId = await getUserId(req);
      const locationId = await getLocationIdByUserId(userId);
      const rawData = req.body;
      const result = await contactService.createContact(locationId, rawData);

    return res.status(201).json({
      success: true,
      message: "Lead successfully added to GoHighLevel pipeline",
    });

  } catch (error: any) {
    console.error("❌ Controller Error:", error.message);
    
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to create contact",
      error: error.response?.data || error.message
    });
  }
};

export const getLocalContactsController = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { locationId } = req.params;

    if (!locationId || typeof locationId !== 'string') {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing locationId parameter",
      });
    }

    const data = await contactService.getLocalContacts(locationId);

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};
