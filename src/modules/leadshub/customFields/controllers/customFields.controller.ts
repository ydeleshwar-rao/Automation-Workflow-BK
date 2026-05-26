
import { Request, Response } from "express";
import { getAllFields } from "../service/field.service.js";
import { getUserId } from "../../../../common/function.js";





export const getCustomFieldsController = async (req: Request, res: Response) => {
  try {
      const userId = await getUserId(req);
    const result = await getAllFields(userId);

    return res.status(200).json(result);
  } catch (error) {
    console.error("Field Fetch Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch fields",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
