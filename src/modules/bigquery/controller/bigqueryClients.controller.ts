import { Request, Response } from "express";
import { BigQueryClientsService } from "../service/bigqueryClients.service.js";
import { ApiResponse } from "../../../utils/ApiResponse.js";


export class BigQueryClientsController {
  static getClients = async (_req: Request, res: Response) => {
    const data = await BigQueryClientsService.getClients();

    return ApiResponse(res, 200, "Clients fetched successfully from BigQuery", data);
  };
}