// routes/field.route.ts

import { Request, Response } from "express";
import { getAllFields } from "./field.service.js";


export const getFieldsController = async (req: Request, res: Response) => {
  try {
    const { locationId } = req.params;

    if (!locationId || typeof locationId !== "string") {
      res.status(400).json({
        success: false,
        message: "locationId is required and must be a string",
      });
      return;
    }

    const data = await getAllFields(locationId);

    res.json(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
    res.status(500).json({
      success: false,
      message: errorMessage,
    });
  }
};
