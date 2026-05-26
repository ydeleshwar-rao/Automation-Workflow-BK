import { Request, Response } from "express";
import { CommusoftService } from "../service/commusoft.service.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { getUserId } from "../../../../common/function.js";
import { supabase } from "../../../../config/db.config.js";
import { CommusoftSummaryService } from "../service/summary.service.js";
import {
  cleanEmptyFields,
  firstQueryValue,
  resolveMapTokens,
  toInt,
} from "../../../../utils/commusoft-helpers.js";
import { enqueueSyncJob } from "../../../../queues/sync.queue.js";

export class CommusoftController {

    /**
     * POST /commusoft/generateAccessToken
     */
    static generateAccessToken = async (req: Request, res: Response) => {
        const { username, password, clientId } = req.body;
        const userId = await getUserId(req);
      
        const applicationId = process.env.COMMUSOFT_APPLICATION_ID!;

        if (!username || !password) {
            throw new ApiError(400, "Missing required parameters");
        }

        // Check if user is already connected
        const { data: existing } = await supabase
            .from("commusoft_intigrations")
            .select("user_id, username, updated_at")
            .eq("user_id", userId)
            .maybeSingle();

        if (existing) {
            return ApiResponse(res, 200, "Commusoft account already connected", {
                alreadyConnected: true,
                username:         existing.username,
                connectedAt:      existing.updated_at,
            });
        }

        await CommusoftService.generateAccessToken(userId, clientId, username, password, applicationId);
        return ApiResponse(res, 200, "Access token generated successfully", { alreadyConnected: false });
    };

    /**
     * GET /commusoft/getjobsbyemail/:email
     */


    /**
     * GET /commusoft/customers — live Commusoft API list (also upserts commusoft_customers)
     */
    static getCustomers = async (req: Request, res: Response) => {
        const userId = await getUserId(req);
        const data = await CommusoftService.getCustomers(userId);
        return ApiResponse(res, 200, "Customers fetched successfully", data);
    };

    /**
     * POST /commusoft/customers/sync — sync all customers from Commusoft into `customers` table
     */
    static syncCustomersDirectory = async (req: Request, res: Response) => {
        try {
            const userId = await getUserId(req);
            const result = await CommusoftService.syncCustomers(userId, {
              source: "api",
            });
            return res.status(200).json({
                success: true,
                message: "Customers synced successfully",
                data: result,
            });
        } catch (error: any) {
            console.error("[Controller] Customer directory sync failed:", error);
            return res.status(500).json({
                success: false,
                message: error.message || "Failed to sync customers",
            });
        }
    };

    /**
     * GET /commusoft/customerdetails — returns nested customer array (no wrapper)
     */
    static getCustomerDetails = async (req: Request, res: Response) => {
        try {
            const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
            const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

            if (limit !== undefined && (Number.isNaN(limit) || limit < 1 || limit > 100)) {
                return res.status(400).json({
                    error: "limit must be between 1 and 100",
                });
            }

            const userId = await getUserId(req);
            const result = await CommusoftService.getCustomerDetails(userId, limit, offset);

            return res.status(200).json(result);
        } catch (error: any) {
            console.error("[Controller] Get customer details failed:", error);
            return res.status(500).json({
                error: error.message || "Failed to fetch customer details",
            });
        }
    };

    /**
     * POST /commusoft/customerdetails/sync
     */
    static syncCustomerDetails = async (req: Request, res: Response) => {
        try {
            const userId = await getUserId(req);

            console.log("[Controller] Triggering customer details sync for user:", userId);

            const result = await CommusoftService.syncCustomerDetails(userId);

            return res.status(200).json(result);
        } catch (error: any) {
            console.error("[Controller] Sync failed:", error);
            return res.status(500).json({
                success: false,
                message: error.message || "Sync failed",
            });
        }
    };

     static getJobs = async (req: Request, res: Response) => {
        const userId = await getUserId(req);
        const data = await CommusoftService.getJobs(userId);
        return ApiResponse(res, 200, "Jobs fetched successfully", data);
    };

      static getJobswithCustomFields = async (req: Request, res: Response) => {
        const userId = await getUserId(req);
        const data = await CommusoftSummaryService.getAllJobDetails(userId);
        return ApiResponse(res, 200, "Jobs fetched successfully", data);
    };


    // /**
    //  * GET /commusoft/customers/:id
    //  */
    // static getCustomerById = async (req: Request, res: Response) => {
    //     const { id } = req.params;
    //     const { baseUrl, token } = req.commusoft!;
    //     const data = await CommusoftService.getCustomerById(baseUrl, token, id);
    //     return ApiResponse(res, 200, "Customer fetched successfully", data);
    // };

    // /**
    //  * GET /commusoft/customers/:id/jobs
    //  */
    // static getJobsByCustomerId = async (req: Request, res: Response) => {
    //     const { id } = req.params;
    //     const { baseUrl, token } = req.commusoft!;
    //     const data = await CommusoftService.getJobsByCustomerId(baseUrl, token, id);
    //     return ApiResponse(res, 200, "Jobs fetched successfully", data);
    // };

    /**
     * GET /commusoft/engineers
     */
    // static getEngineers = async (req: Request, res: Response) => {
    //    const userId = await getUserId(req);
    //     const data = await CommusoftService.getEngineers(userId);
    //     return ApiResponse(res, 200, "Engineers fetched successfully", data);
    // };

       /**
     * GET /commusoft/engineers get user preference
     */
    static getCustomerTypes = async (req: Request, res: Response) => {
        const userId = await getUserId(req);
        const data = await CommusoftService.getCustomerTypes(userId);
        return ApiResponse(res, 200, "Customer types fetched successfully", data);
    };

static getUserPreference = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await CommusoftService.getUserPreference(userId);
    return ApiResponse(res, 200, "User preference fetched successfully", data);
};

static getDiaryEvents = async (req: Request, res: Response) => {
    const userId = await getUserId(req);

    const data = await CommusoftService.getDiaryEvents(userId, {
      fromdate: firstQueryValue(req.query.fromdate),
      todate: firstQueryValue(req.query.todate),
      engineerids: firstQueryValue(req.query.engineerids),
      basicinfo: firstQueryValue(req.query.basicinfo),
      tabletype: firstQueryValue(req.query.tabletype),
      tablepkid: firstQueryValue(req.query.tablepkid),
      propertyId: firstQueryValue(req.query.propertyId),
      createdByType: firstQueryValue(req.query.createdByType),
    });

    return ApiResponse(res, 200, "Diary events fetched successfully", data);
};

    /**
     * GET /commusoft/jobdescriptions
     */
    static getJobDescriptions = async (req: Request, res: Response) => {
        const userId = await getUserId(req);
        const data = await CommusoftService.getJobDescriptions(userId);
        return ApiResponse(res, 200, "Job descriptions fetched successfully", data);
    };

    static getOpportunityPipelines = async (req: Request, res: Response) => {
        const userId = await getUserId(req);

        const data = await CommusoftService.getOpportunityPipelines(userId, {
          page: firstQueryValue(req.query.page),
          limit: firstQueryValue(req.query.limit),
          searchText: firstQueryValue(req.query.searchText),
          status: firstQueryValue(req.query.status),
        });

        return ApiResponse(res, 200, "Opportunity pipelines fetched successfully", data);
    };

    static getOpportunityPipelineStages = async (req: Request, res: Response) => {
        const userId = await getUserId(req);
        const rawPipelineId = req.params.pipelineId;
        const pipelineId = Array.isArray(rawPipelineId) ? rawPipelineId[0] : rawPipelineId;

        if (!pipelineId) {
          throw new ApiError(400, "pipelineId is required");
        }

        const data = await CommusoftService.getOpportunityPipelineStages(userId, pipelineId);
        return ApiResponse(res, 200, "Opportunity pipeline stages fetched successfully", data);
    };

    static getStageOpportunities = async (req: Request, res: Response) => {
        const userId = await getUserId(req);
        const rawStageId = req.params.stageId;
        const stageId = Array.isArray(rawStageId) ? rawStageId[0] : rawStageId;

        if (!stageId) {
          throw new ApiError(400, "stageId is required");
        }

        const data = await CommusoftService.getStageOpportunities(userId, stageId, {
          limit: firstQueryValue(req.query.limit),
          searchText: firstQueryValue(req.query.searchText),
          salesPersonId: firstQueryValue(req.query.salesPersonId),
          lowValue: firstQueryValue(req.query.lowValue),
          highValue: firstQueryValue(req.query.highValue),
        });

        return ApiResponse(res, 200, "Stage opportunities fetched successfully", data);
    };

    static getOpportunityDetails = async (req: Request, res: Response) => {
        const userId = await getUserId(req);
        const rawOpportunityId = req.params.opportunityId;
        const opportunityId = Array.isArray(rawOpportunityId) ? rawOpportunityId[0] : rawOpportunityId;

        if (!opportunityId) {
          throw new ApiError(400, "opportunityId is required");
        }

        const data = await CommusoftService.getOpportunityDetails(userId, opportunityId);
        return ApiResponse(res, 200, "Opportunity details fetched successfully", data);
    };

    static getCustomerOpportunityStages = async (req: Request, res: Response) => {
        const userId = await getUserId(req);
        const rawCustomerId = req.params.customerId;
        const rawOpportunityId = req.params.opportunityId;
        const customerId = Array.isArray(rawCustomerId) ? rawCustomerId[0] : rawCustomerId;
        const opportunityId = Array.isArray(rawOpportunityId) ? rawOpportunityId[0] : rawOpportunityId;

        if (!customerId) {
          throw new ApiError(400, "customerId is required");
        }
        if (!opportunityId) {
          throw new ApiError(400, "opportunityId is required");
        }

        const data = await CommusoftService.getCustomerOpportunityStages(userId, customerId, opportunityId);
        return ApiResponse(res, 200, "Customer opportunity stages fetched successfully", data);
    };

    static getOpportunityTemplates = async (req: Request, res: Response) => {
        const userId = await getUserId(req);
        const data = await CommusoftService.getOpportunityTemplates(userId);
        return ApiResponse(res, 200, "Opportunity templates fetched successfully", data);
    };

    static getOutstandingJobsAndEstimates = async (req: Request, res: Response) => {
        const userId = await getUserId(req);

        const data = await CommusoftService.getOutstandingJobsAndEstimates(userId, {
          id: firstQueryValue(req.query.id),
          searchText: firstQueryValue(req.query.searchText),
          genericSearchText: firstQueryValue(req.query.genericSearchText),
          status: firstQueryValue(req.query.status),
          limit: firstQueryValue(req.query.limit),
        });

        return ApiResponse(res, 200, "Outstanding jobs and estimates fetched successfully", data);
    };

    static scanStageOpportunities = async (req: Request, res: Response) => {
        const userId = await getUserId(req);

        const options = Object.fromEntries(
          Object.entries({
            from: toInt(req.query.from),
            to: toInt(req.query.to),
            limit: firstQueryValue(req.query.limit),
            enrich: firstQueryValue(req.query.enrich) === "true" ? true : undefined,
            searchText: firstQueryValue(req.query.searchText),
            salesPersonId: firstQueryValue(req.query.salesPersonId),
            lowValue: firstQueryValue(req.query.lowValue),
            highValue: firstQueryValue(req.query.highValue),
          }).filter(([, value]) => value !== undefined)
        ) as Parameters<typeof CommusoftService.scanStageOpportunities>[1];

        const data = await CommusoftService.scanStageOpportunities(userId, options);

        return ApiResponse(res, 200, "Stage scan completed successfully", data);
    };

static syncAll = async (req: Request, res: Response) => {
    const userId = await getUserId(req);

    const rawBatch =
      req.query.no_of_records ?? req.query.batch_size ?? req.body?.no_of_records;
    const parsed =
      rawBatch !== undefined && rawBatch !== null && String(rawBatch).trim() !== ""
        ? parseInt(String(Array.isArray(rawBatch) ? rawBatch[0] : rawBatch), 10)
        : undefined;
    const batchSize =
      parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;

    console.log(
      `[Commusoft:Controller] Sync triggered batchSize=${batchSize ?? "default"} query=${JSON.stringify(req.query)}`
    );

    const force = req.query.force === "true" || req.body?.force === true;

    const result = await enqueueSyncJob({ userId, integration: "commusoft", batchSize, force });

    if (!result.queued) {
      const mins = Math.ceil(result.remainingMs / 60_000);
      return ApiResponse(res, 429, `Sync ran recently. Next allowed in ${mins} min.`, {
        reason:       "cooldown",
        lastSyncedAt: result.lastSyncedAt,
        remainingMs:  result.remainingMs,
        tip:          "Add ?force=true to bypass cooldown",
      });
    }

    return ApiResponse(res, 202, "Commusoft sync queued", { jobId: result.jobId });
};

static getSyncStatus = async (req: Request, res: Response) => {
    const userId = await getUserId(req);

    const { data, error } = await supabase
      .from("sync_checkpoints")
      .select("integration, entity, status, last_page, records_synced, started_at, updated_at, finished_at, error_message")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });

    if (error) throw error;
    return ApiResponse(res, 200, "Sync status fetched", data ?? []);
};

static getJobsByEmailOrPhone = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
   console.log("getJobFullDetailsByEmailOrPhone", req.query);
    let email = req.query.email as string | string[] | undefined;
    let phone = req.query.phone as string | string[] | undefined;
    if (Array.isArray(email)) email = email[0];
    if (Array.isArray(phone)) phone = phone[0];
    if (!email && !phone) {
      return ApiResponse(res, 400, "Either email or phone query parameter is required", null);
    }
    const data = await CommusoftSummaryService.getJobDetailsListByEmailOrPhone(userId, email?.trim(), phone?.trim());
    return ApiResponse(res, 200, "Jobs fetched successfully", data);
}
static getStaffMembers = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await CommusoftService.getStaffMembers(userId);
    return ApiResponse(res, 200, "Staff members fetched successfully", data);
};

static getAllJobs = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    console.log(`[Commusoft:getAllJobs] query=${JSON.stringify(req.query)}`);

    const periodToDateRange = (period: string): { dateFrom: string; dateTo: string } | undefined => {
      const today = new Date();
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const from = new Date(today);
      if      (period === "week")  from.setDate(from.getDate() - 6);
      else if (period === "month") from.setDate(from.getDate() - 29);
      else if (period === "year")  from.setFullYear(from.getFullYear() - 1);
      else return undefined;
      return { dateFrom: fmt(from), dateTo: fmt(today) };
    };

    const q = req.query;
    const filters: Parameters<typeof CommusoftSummaryService.getJobs>[1] = {};

    // Same param names as ServiceM8 so UI sends identical query strings
    if (firstQueryValue(q.queue_uuid))    filters.queueUuid    = firstQueryValue(q.queue_uuid)!;
    if (firstQueryValue(q.category_uuid)) filters.categoryUuid = firstQueryValue(q.category_uuid)!;
    if (firstQueryValue(q.status))        filters.status       = firstQueryValue(q.status)!;
    if (firstQueryValue(q.staff_uuid))    filters.staffUuid    = firstQueryValue(q.staff_uuid)!;
    if (firstQueryValue(q.company_uuid))  filters.companyUuid  = firstQueryValue(q.company_uuid)!;

    // date_from / date_to take priority; period is the fallback shorthand
    const dateFrom = firstQueryValue(q.date_from);
    const dateTo   = firstQueryValue(q.date_to);
    const period   = firstQueryValue(q.period);

    if (dateFrom || dateTo) {
      if (dateFrom) filters.dateFrom = dateFrom;
      if (dateTo)   filters.dateTo   = dateTo;
    } else if (period) {
      const range = periodToDateRange(period);
      if (range) {
        filters.dateFrom = range.dateFrom;
        filters.dateTo   = range.dateTo;
      }
    }

    const limit  = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    const cursor = req.query.cursor as string | undefined;

    console.log(`[Commusoft:getAllJobs] filters=${JSON.stringify(filters)} limit=${limit} cursor=${cursor ?? "none"}`);

    try {
      const result = await CommusoftSummaryService.getJobs(userId, filters, {
        limit,
        ...(cursor !== undefined && { cursor }),
      });
      console.log(`[Commusoft:getAllJobs] ◀ ${result.data.length} job(s) has_more=${result.meta.has_more}`);

      res.setHeader("Content-Type", "application/json");
      res.write('{"success":true,"data":[');
      for (let i = 0; i < result.data.length; i++) {
        if (i > 0) res.write(",");
        res.write(JSON.stringify(result.data[i]));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      res.write(`],"meta":${JSON.stringify(result.meta)}}`);
      res.end();
    } catch (error: any) {
      console.error(`[Commusoft:getAllJobs] ✖ failed error=${error?.message}`);
      if (!res.headersSent) throw error;
    }
}

static getConnectionStatus = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await CommusoftService.getConnectionStatus(userId);
    return ApiResponse(res, 200, "Connection status fetched successfully", data);
};

static disconnect = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const data = await CommusoftService.disconnect(userId);
    return ApiResponse(res, 200, "Commusoft account disconnected successfully", data);
};

static createCustomer = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    // 1. Resolve {{map:id|label|fallback}} tokens → fallback — the UI's Test
    //    action button sends raw config with unresolved tokens (no upstream
    //    trigger output exists at test time). Real workflow execution uses the
    //    token resolver in webhookProcessor against actual trigger data.
    const resolved = resolveMapTokens(req.body || {});
    // 2. Drop empty fields so the Commusoft API doesn't 400 on blank optionals
    //    (postcode, landline, etc.). Covers fully-static, fully-mapped, and
    //    mixed configurations.
    const { cleaned: customerData, dropped } = cleanEmptyFields(resolved);

    if (!customerData || !customerData.customer_type) {
        throw new ApiError(400, "customer_type is required in the request body");
    }

    console.log(
      `[Commusoft:createCustomer] resolved & cleaned payload  kept=[${Object.keys(customerData).join(", ")}]  dropped=[${dropped.join(", ") || "(none)"}]  customer_type="${customerData.customer_type}"`
    );

    const data = await CommusoftService.createCustomer(userId, customerData);
    return ApiResponse(res, 201, "Customer created successfully in Commusoft", data);
};

static createJob = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const resolved = resolveMapTokens(req.body || {});
    const { cleaned: jobData, dropped } = cleanEmptyFields(resolved);

    if (!jobData.customer_id && !jobData.customer_uuid && !jobData.customer_name && !jobData.email) {
        throw new ApiError(400, "customer_id, customer_uuid, customer_name, or email is required");
    }

    if (!jobData.description && !jobData.job_description) {
        throw new ApiError(400, "description or job_description is required");
    }

    console.log(
      `[Commusoft:createJob] resolved & cleaned payload  kept=[${Object.keys(jobData).join(", ")}]  dropped=[${dropped.join(", ") || "(none)"}]`
    );

    const data = await CommusoftService.createJob(userId, jobData);
    return ApiResponse(res, 201, "Job created successfully in Commusoft", data);
};

static createDiaryEvent = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const resolved = resolveMapTokens(req.body || {});
    const { cleaned: diaryData, dropped } = cleanEmptyFields(resolved);

    if (!diaryData.event_type && !diaryData.eventType) {
        throw new ApiError(400, "event_type is required");
    }

    if (!diaryData.description) {
        throw new ApiError(400, "description is required");
    }

    if (!diaryData.engineer_notes) {
        throw new ApiError(400, "engineer_notes is required");
    }

    if (!diaryData.event_start || !diaryData.event_end) {
        throw new ApiError(400, "event_start and event_end are required");
    }

    if (!diaryData.resource_id && !diaryData.resourceId) {
        throw new ApiError(400, "resource_id is required");
    }

    const eventType = diaryData.event_type || diaryData.eventType;
    if (eventType === "job" && !diaryData.job_id && !diaryData.jobid) {
        throw new ApiError(400, "job_id is required when event_type is job");
    }

    console.log(
      `[Commusoft:createDiaryEvent] resolved & cleaned payload  kept=[${Object.keys(diaryData).join(", ")}]  dropped=[${dropped.join(", ") || "(none)"}]`
    );

    const data = await CommusoftService.createDiaryEvent(userId, diaryData);
    return ApiResponse(res, 201, "Diary event created successfully in Commusoft", data);
};

static createOpportunity = async (req: Request, res: Response) => {
    const userId = await getUserId(req);
    const resolved = resolveMapTokens(req.body || {});
    const { cleaned: opportunityData, dropped } = cleanEmptyFields(resolved);

    if (
      !opportunityData.customer_id &&
      !opportunityData.customer_uuid &&
      !opportunityData.customer_name &&
      !opportunityData.email
    ) {
        throw new ApiError(400, "customer_id, customer_uuid, customer_name, or email is required");
    }

    console.log(
      `[Commusoft:createOpportunity] resolved & cleaned payload  kept=[${Object.keys(opportunityData).join(", ")}]  dropped=[${dropped.join(", ") || "(none)"}]`
    );

    const data = await CommusoftService.createOpportunity(userId, opportunityData);
    return ApiResponse(res, 201, "Opportunity created successfully in Commusoft", data);
};
}
