import { Request, Response, NextFunction } from "express";
import { ServiceM8Service } from "../service/serviceM8.service.js";
import { ApiResponse } from "../../../../utils/ApiResponse.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { validateId } from "../../../../utils/CustomFunc.js";
import { supabase } from "../../../../config/db.config.js";
import { SummaryService } from "../service/summary.service.js";
import { StaffSummaryService } from "../service/staff_summary.service.js";
import { getUserId } from "../../../../common/function.js";



const firstStr = (v: unknown): string | undefined => {
  const raw = Array.isArray(v) ? v[0] : v;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
};

const resolveUuidByName = async (
  table: "servicem8_queues" | "servicem8_categories",
  userId: string,
  name: string
): Promise<string | null> => {
  const { data } = await supabase
    .from(table)
    .select("uuid")
    .eq("user_id", userId)
    .ilike("name", name)
    .maybeSingle();
  return data?.uuid ?? null;
};

type JobFilterSet = {
  queueUuid?: string;
  categoryUuid?: string;
  status?: string;
  dateFrom?: string;   // YYYY-MM-DD
  dateTo?: string;     // YYYY-MM-DD
  staffUuid?: string;
  companyUuid?: string;
};

// "week" | "month" | "year" — relative to today, inclusive of today.
const periodToDateRange = (
  period: string
): { dateFrom: string; dateTo: string } | undefined => {
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const from = new Date(today);
  if (period === "week") from.setDate(from.getDate() - 6);
  else if (period === "month") from.setDate(from.getDate() - 29);
  else if (period === "year") from.setFullYear(from.getFullYear() - 1);
  else return undefined;
  return { dateFrom: fmt(from), dateTo: fmt(today) };
};

const resolveJobFilters = async (
  userId: string,
  req: Request
): Promise<JobFilterSet> => {
  const queueUuid = firstStr(req.query.queue_uuid);
  const categoryUuid = firstStr(req.query.category_uuid);
  const queueName = firstStr(req.query.queue_name);
  const categoryName = firstStr(req.query.category_name);
  const status = firstStr(req.query.status);
  const staffUuid = firstStr(req.query.staff_uuid);
  const companyUuid = firstStr(req.query.company_uuid);
  const dateFromQ = firstStr(req.query.date_from);
  const dateToQ = firstStr(req.query.date_to);
  const period = firstStr(req.query.period);

  const filters: JobFilterSet = {};

  if (queueUuid) filters.queueUuid = queueUuid;
  else if (queueName) {
    const uuid = await resolveUuidByName("servicem8_queues", userId, queueName);
    if (uuid) filters.queueUuid = uuid;
  }

  if (categoryUuid) filters.categoryUuid = categoryUuid;
  else if (categoryName) {
    const uuid = await resolveUuidByName("servicem8_categories", userId, categoryName);
    if (uuid) filters.categoryUuid = uuid;
  }

  if (status)      filters.status = status;
  if (staffUuid)   filters.staffUuid = staffUuid;
  if (companyUuid) filters.companyUuid = companyUuid;

  // Explicit date_from/date_to wins over period; otherwise derive from period.
  if (dateFromQ || dateToQ) {
    if (dateFromQ) filters.dateFrom = dateFromQ;
    if (dateToQ)   filters.dateTo = dateToQ;
  } else if (period) {
    const range = periodToDateRange(period);
    if (range) {
      filters.dateFrom = range.dateFrom;
      filters.dateTo = range.dateTo;
    }
  }

  return filters;
};

export class ServiceM8Controller {

  // ─── 1. Companies (Clients) ───────────────────────────────────────────────
  static listClients = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data, sm8 } = await ServiceM8Service.listClients(userId);
      return ApiResponse(res, 200, "Clients retrieved and synced successfully", data, { sm8 });
    } catch (error) {
      next(error);
    }
  };

  static createClient = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const data = await ServiceM8Service.createClient(userId, req.body);
      return ApiResponse(res, 201, "Client created successfully", data);
    } catch (error) {
      next(error);
    }
  };

  static updateClient = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { id } = req.params;
      validateId(id);
      const data = await ServiceM8Service.updateClient(userId, id, req.body);
      return ApiResponse(res, 200, "Client updated successfully", data);
    } catch (error) {
      next(error);
    }
  };

  // ─── 2. Contacts ──────────────────────────────────────────────────────────
  static listContacts = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data, sm8 } = await ServiceM8Service.listContacts(userId);
      return ApiResponse(res, 200, "Contacts retrieved and synced successfully", data, { sm8 });
    } catch (error) {
      next(error);
    }
  };

  // ─── 3. Locations ─────────────────────────────────────────────────────────
  static listLocations = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data, sm8 } = await ServiceM8Service.listLocations(userId);
      return ApiResponse(res, 200, "Locations retrieved and synced successfully", data, { sm8 });
    } catch (error) {
      next(error);
    }
  };

  static createLocation = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const data = await ServiceM8Service.createLocation(userId, req.body);
      return ApiResponse(res, 201, "Location created successfully", data);
    } catch (error) {
      next(error);
    }
  };

  // ─── 4. Jobs ──────────────────────────────────────────────────────────────
  static listJobs = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data, sm8 } = await ServiceM8Service.listJobs(userId);
      return ApiResponse(res, 200, "Jobs retrieved and synced successfully", data, { sm8 });
    } catch (error) {
      next(error);
    }
  };

  static createJob = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const data = await ServiceM8Service.createJob(userId, req.body);
      return ApiResponse(res, 201, "Job created successfully", data);
    } catch (error) {
      next(error);
    }
  };

  static updateJob = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { id } = req.params;
      validateId(id);
      const data = await ServiceM8Service.updateJob(userId, id, req.body);
      return ApiResponse(res, 200, "Job updated successfully", data);
    } catch (error) {
      next(error);
    }
  };

  // ─── 5. Staff Members ─────────────────────────────────────────────────────
  static listStaffMembers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data, sm8 } = await ServiceM8Service.listStaffMembers(userId);
      return ApiResponse(res, 200, "Staff members retrieved and synced successfully", data, { sm8 });
    } catch (error) {
      next(error);
    }
  };

  static listActiveStaff = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data, sm8 } = await ServiceM8Service.listActiveStaffForSelect(userId);
      return ApiResponse(res, 200, "Active staff retrieved successfully", data, { sm8 });
    } catch (error) {
      next(error);
    }
  };

  // ─── 6. Categories ────────────────────────────────────────────────────────
  static listCategories = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data, sm8 } = await ServiceM8Service.listCategories(userId);
      return ApiResponse(res, 200, "Categories retrieved and synced successfully", data, { sm8 });
    } catch (error) {
      next(error);
    }
  };

  // ─── 7. Queues ────────────────────────────────────────────────────────────
  static listQueues = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data, sm8 } = await ServiceM8Service.listQueues(userId);
      return ApiResponse(res, 200, "Queues retrieved and synced successfully", data, { sm8 });
    } catch (error) {
      next(error);
    }
  };

  // ─── 8. Job Allocations ───────────────────────────────────────────────────
  static listJobAllocations = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data, sm8 } = await ServiceM8Service.listJobAllocations(userId);
      return ApiResponse(res, 200, "Job allocations retrieved successfully", data, { sm8 });
    } catch (error) {
      next(error);
    }
  };

  static createJobAllocation = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const data = await ServiceM8Service.createJobAllocation(userId, req.body);
      return ApiResponse(res, 201, "Job allocation created successfully", data);
    } catch (error) {
      next(error);
    }
  };

  // ─── 9. Materials ─────────────────────────────────────────────────────────
  static listMaterials = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data, sm8 } = await ServiceM8Service.listMaterials(userId);
      return ApiResponse(res, 200, "Materials retrieved successfully", data, { sm8 });
    } catch (error) {
      next(error);
    }
  };

  static listJobMaterials = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data, sm8 } = await ServiceM8Service.listJobMaterials(userId);
      return ApiResponse(res, 200, "Job materials retrieved successfully", data, { sm8 });
    } catch (error) {
      next(error);
    }
  };

  static createJobMaterial = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const data = await ServiceM8Service.createJobMaterial(userId, req.body);
      return ApiResponse(res, 201, "Job material created successfully", data);
    } catch (error) {
      next(error);
    }
  };

  // ─── 10. Notes ────────────────────────────────────────────────────────────
  static listNotes = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data, sm8 } = await ServiceM8Service.listNotes(userId);
      return ApiResponse(res, 200, "Notes retrieved successfully", data, { sm8 });
    } catch (error) {
      next(error);
    }
  };

  static createNote = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const data = await ServiceM8Service.createNote(userId, req.body);
      return ApiResponse(res, 201, "Note created successfully", data);
    } catch (error) {
      next(error);
    }
  };

  // ─── 11. Job Payments ─────────────────────────────────────────────────────
  static listJobPayments = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data, sm8 } = await ServiceM8Service.listJobPayments(userId);
      return ApiResponse(res, 200, "Job payments retrieved and synced successfully", data, { sm8 });
    } catch (error) {
      next(error);
    }
  };

  // ─── 12. Sync All ─────────────────────────────────────────────────────────
  static syncAll = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const result = await ServiceM8Service.syncAll(userId);
      const statusCode = result.overall === "failed" ? 500 : 200;
      const message =
        result.overall === "success" ? "Full sync completed successfully" :
        result.overall === "partial" ? `Partial sync — failed: ${result.failedEntities.join(", ")}` :
                                       "Sync failed for all entities";
      return ApiResponse(res, statusCode, message, result);
    } catch (error) {
      next(error);
    }
  };

  // ─── 13. Get All Jobs ─────────────────────────────────────────────────────
  // Always hits ServiceM8 live API (fresh sync into local DB) so the dashboard
  // sees up-to-date data. Filters supported via query params:
  //   queue_uuid | queue_name
  //   category_uuid | category_name
  //   status                              (e.g. "Quote", "Work Order", "Completed")
  //   date_from=YYYY-MM-DD&date_to=...    (inclusive)
  //   period=week|month|year              (overridden by explicit date_from/date_to)
  //   staff_uuid                          (matched against completion_actioned_by_uuid)
  //   company_uuid
  static getAllJobs = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      console.log(
        `[GetAllJobs] ▶ request received  user=${userId}  query=${JSON.stringify(req.query)}`
      );

      const filters = await resolveJobFilters(userId, req);
      console.log(
        `[GetAllJobs] ✓ filters resolved  ${JSON.stringify(filters)}`
      );

      const limit  = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
      const cursor = req.query.cursor as string | undefined;

      const result = await SummaryService.getJobs(userId, undefined, filters, {
        limit,
        ...(cursor !== undefined && { cursor }),
      });
      console.log(`[GetAllJobs] ◀ ${result.data.length} group(s) has_more=${result.meta.has_more} user=${userId}`);

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
      console.error(`[GetAllJobs] ✖ failed  error=${error?.message}`);
      if (!res.headersSent) next(error);
    }
  };

  // ─── 14. Job Full Details ─────────────────────────────────────────────────
  static getJobFullDetails = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);

      let generatedJobId = req.params.generatedJobId || req.query.generatedJobId;
      if (Array.isArray(generatedJobId)) generatedJobId = generatedJobId[0];

      if (!generatedJobId) {
        return ApiResponse(res, 400, "generatedJobId is required", null);
      }

      const data = await SummaryService.getJobDetails(userId, generatedJobId as string);
      return ApiResponse(res, 200, "Job details fetched successfully", data);
    } catch (error) {
      next(error);
    }
  };

  // ─── 15. Jobs by Email or Phone ───────────────────────────────────────────
  static getJobFullDetailsByEmailOrPhone = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      let email = req.query.email as string | string[] | undefined;
      let phone = req.query.phone as string | string[] | undefined;
      if (Array.isArray(email)) email = email[0];
      if (Array.isArray(phone)) phone = phone[0];

      const normalizedEmail = typeof email === "string" ? email.trim() : undefined;
      const normalizedPhone = typeof phone === "string" ? phone.trim() : undefined;

      if (!normalizedEmail && !normalizedPhone) {
        return ApiResponse(res, 400, "email or phone query parameter is required", null);
      }

      const result = await SummaryService.getJobDetailsListByEmailOrPhone(userId, normalizedEmail, normalizedPhone);
      return ApiResponse(res, 200, "Job details fetched successfully", result);
    } catch (error) {
      next(error);
    }
  };

  // ─── 16. Get Jobs (unified) ───────────────────────────────────────────────
  static getJobs = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);

      let generatedJobId = req.query.generatedJobId as string | string[] | undefined;
      if (Array.isArray(generatedJobId)) generatedJobId = generatedJobId[0];

      let email = req.query.email as string | string[] | undefined;
      let phone = req.query.phone as string | string[] | undefined;
      if (Array.isArray(email)) email = email[0];
      if (Array.isArray(phone)) phone = phone[0];

      if (generatedJobId) {
        const result = await SummaryService.getJobs(userId, generatedJobId as string);
        return ApiResponse(res, 200, "Job details fetched successfully", result);
      }

      if (email || phone) {
        const normalizedEmail = typeof email === "string" ? email.trim() : undefined;
        const normalizedPhone = typeof phone === "string" ? phone.trim() : undefined;
        const result = await SummaryService.getJobDetailsListByEmailOrPhone(userId, normalizedEmail, normalizedPhone);
        return ApiResponse(res, 200, "Job details fetched successfully", result);
      }

      const filters = await resolveJobFilters(userId, req);
      const result = await SummaryService.getJobs(userId, undefined, filters);
      return ApiResponse(res, 200, "All jobs fetched successfully", result);
    } catch (error) {
      next(error);
    }
  };

  // ─── 17. Get Job IDs ──────────────────────────────────────────────────────
  static getJobIds = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const data = await SummaryService.getAllJobIds(userId);
      return ApiResponse(res, 200, "Job IDs fetched successfully", data);
    } catch (error) {
      next(error);
    }
  };

  // ─── 18. Get Staffs (job_title, email, phone filters) ───────────────────
  static getStaffs = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);

      // job_title — single value
      let jobTitle = req.query.job_title as string | string[] | undefined;
      if (Array.isArray(jobTitle)) jobTitle = jobTitle[0];
      const normalizedJobTitle = typeof jobTitle === "string" ? jobTitle.trim() : undefined;

      // email — single value
      let email = req.query.email as string | string[] | undefined;
      if (Array.isArray(email)) email = email[0];
      const normalizedEmail = typeof email === "string" ? email.trim() : undefined;

      // phone — single value
      let phone = req.query.phone as string | string[] | undefined;
      if (Array.isArray(phone)) phone = phone[0];
      const normalizedPhone = typeof phone === "string" ? phone.trim() : undefined;

      const data = await StaffSummaryService.getStaffs(userId, {
        jobTitle: normalizedJobTitle,
        email: normalizedEmail,
        phone: normalizedPhone,
      });

      const message = data.length === 0 ? "No staff matched the provided filters" : "Staffs retrieved successfully";

      return ApiResponse(res, 200, message, { total: data.length, staffs: data });
    } catch (error) {
      next(error);
    }
  };

  // ─── Job Statuses ──────────────────────────────────────────────────────────
  static getJobStatuses = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
    
      const data = await ServiceM8Service.getJobStatuses(userId);
      return ApiResponse(res, 200, "Job statuses retrieved successfully", data);
    } catch (error) {
      next(error);
    }
  };

  // ─── OAuth / Auth endpoints ───────────────────────────────────────────────

  static getConnectUrl = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId      = await getUserId(req);
      const clientId    = process.env.SERVICEM8_CLIENT_ID;
      const redirectUri = process.env.SERVICEM8_REDIRECT_URI;
      const scopes      = process.env.SERVICEM8_SCOPE;

      if (!clientId || !redirectUri) {
        throw new ApiError(500, "ServiceM8 config missing");
      }

      // Check if user is already connected and healthy (not flagged for re-auth)
      const { data: existing } = await supabase
        .from("servicem8_integrations")
        .select("user_id, expires_at, scopes, needs_reauth")
        .eq("user_id", userId)
        .maybeSingle();

      if (existing && !existing.needs_reauth) {
        return ApiResponse(res, 200, "ServiceM8 account already connected", {
          alreadyConnected: true,
          expires_at:       existing.expires_at,
          scopes:           existing.scopes,
        });
      }

      const statePayload = Buffer.from(JSON.stringify({ userId })).toString("base64url");

      const params = new URLSearchParams({
        response_type: "code",
        client_id:     clientId,
        redirect_uri:  redirectUri,
        scope:         scopes!,
        state:         statePayload,
      });

      const url = `https://go.servicem8.com/oauth/authorize?${params.toString()}`;
      return ApiResponse(res, 200, "Auth URL generated", { alreadyConnected: false, url });
    } catch (error) {
      next(error);
    }
  };

  static handleCallback = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code, state } = req.query;

      if (!code)  throw new ApiError(400, "No authorization code");
      if (!state) throw new ApiError(400, "State missing");

      let userId: string;
      try {
        const decoded = JSON.parse(Buffer.from(state as string, "base64url").toString("utf8"));
        userId = decoded.userId;
      } catch {
        throw new ApiError(400, "Invalid state parameter");
      }

      if (!userId) throw new ApiError(400, "User ID missing in state");

      const tokenUrl = process.env.SERVICEM8_TOKEN_URL || "https://go.servicem8.com/oauth/access_token";

      const tokenRes = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id:     process.env.SERVICEM8_CLIENT_ID!,
          client_secret: process.env.SERVICEM8_CLIENT_SECRET!,
          grant_type:    "authorization_code",
          code:          code as string,
          redirect_uri:  process.env.SERVICEM8_REDIRECT_URI!,
        }),
      });

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) throw new ApiError(tokenRes.status, tokenData?.error_description || tokenData?.error || "Token exchange failed");

      // Identify the ServiceM8 account UUID so token refreshes can be synced
      // across all users who share the same ServiceM8 account.
      let sm8AccountUuid: string | null = null;
      try {
        const companyRes = await fetch("https://api.servicem8.com/api_1.0/company.json", {
          headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/json" },
        });
        if (companyRes.ok) {
          const companyData = await companyRes.json();
          const first = Array.isArray(companyData) ? companyData[0] : companyData;
          sm8AccountUuid = first?.uuid ?? null;
          console.log(`[ServiceM8 Callback] sm8_account_uuid resolved: ${sm8AccountUuid}`);
        } else {
          console.warn(`[ServiceM8 Callback] /company.json returned ${companyRes.status}`);
        }
      } catch (e) {
        console.warn("[ServiceM8 Callback] Could not fetch company UUID:", e);
      }

      const expiresAt = new Date();
      expiresAt.setSeconds(expiresAt.getSeconds() + (tokenData.expires_in || 3600));

      const { error: upsertError } = await supabase.from("servicem8_integrations").upsert({
        user_id:          userId,
        access_token:     tokenData.access_token,
        refresh_token:    tokenData.refresh_token,
        expires_at:       expiresAt.toISOString(),
        scopes:           tokenData.scope,
        needs_reauth:     false,
        ...(sm8AccountUuid ? { sm8_account_uuid: sm8AccountUuid } : {}),
      }, { onConflict: "user_id" });

      if (upsertError) throw new ApiError(500, `Failed to save ServiceM8 integration: ${upsertError.message}`);
      console.log(`[ServiceM8 Callback] Integration saved — userId=${userId}  sm8_account_uuid=${sm8AccountUuid ?? "null"}`);

      return res.send(`<!DOCTYPE html><html><body><script>window.close();</script><p>Connected successfully. You may close this window.</p></body></html>`);
    } catch (error) {
      next(error);
    }
  };

  static disconnect = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);

      // Check if connection exists before attempting delete
      const { data: existing } = await supabase
        .from("servicem8_integrations")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();

      if (!existing) {
        throw new ApiError(404, "No active ServiceM8 connection found. Account is already disconnected.");
      }

      const { error } = await supabase
        .from("servicem8_integrations")
        .delete()
        .eq("user_id", userId);

      if (error) throw error;
      return ApiResponse(res, 200, "ServiceM8 disconnected successfully", { disconnected: true });
    } catch (error) {
      next(error);
    }
  };

  static connectionStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { data } = await supabase
        .from("servicem8_integrations")
        .select("expires_at, scopes, needs_reauth")
        .eq("user_id", userId)
        .single();

      return ApiResponse(res, 200, "Status fetched", {
        connected:    !!data,
        needs_reauth: data?.needs_reauth ?? false,
      });
    } catch (error) {
      next(error);
    }
  };

  // One-time migration: populate sm8_account_uuid for all users where it is NULL.
  // Call POST /servicem8/backfill-account-uuid once after deploying this fix.
  static backfillAccountUuid = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { data: rows, error } = await supabase
        .from("servicem8_integrations")
        .select("user_id, access_token")
        .is("sm8_account_uuid", null)
        .not("access_token", "is", null);

      if (error) throw error;
      if (!rows || rows.length === 0) {
        return ApiResponse(res, 200, "No rows need backfill", { updated: 0 });
      }

      console.log(`[Backfill] sm8_account_uuid missing for ${rows.length} user(s) — starting...`);
      let updated = 0;
      let failed  = 0;

      for (const row of rows) {
        try {
          const configRes = await fetch("https://api.servicem8.com/api_1.0/CompanyConfig.json", {
            headers: { Authorization: `Bearer ${row.access_token}`, Accept: "application/json" },
          });
          if (!configRes.ok) {
            console.warn(`[Backfill] user=${row.user_id} CompanyConfig HTTP ${configRes.status} — skipping`);
            failed++;
            continue;
          }
          const configData = await configRes.json();
          const record = Array.isArray(configData) ? configData[0] : configData;
          const uuid = record?.uuid ?? null;
          console.log(`[Backfill] user=${row.user_id} → sm8_account_uuid=${uuid}`);

          if (!uuid) { failed++; continue; }

          await supabase
            .from("servicem8_integrations")
            .update({ sm8_account_uuid: uuid })
            .eq("user_id", row.user_id);

          updated++;
        } catch (e: any) {
          console.error(`[Backfill] user=${row.user_id} error:`, e?.message);
          failed++;
        }
      }

      return ApiResponse(res, 200, "Backfill complete", { total: rows.length, updated, failed });
    } catch (error) {
      next(error);
    }
  };

  static authenticateWithCredentials = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = await getUserId(req);
      const { username, password } = req.body;

      if (!username || typeof username !== "string")
        return ApiResponse(res, 400, "Username is required and must be a string");
      if (!password || typeof password !== "string")
        return ApiResponse(res, 400, "Password is required and must be a string");

      const data = await ServiceM8Service.authenticateWithCredentials(userId, username, password);
      return ApiResponse(res, 200, "ServiceM8 authenticated successfully", {
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        user_id:       data.user_id,
        expires_at:    data.expires_at,
        expires_in:    data.expires_in,
        scope:         data.scope,
      });
    } catch (error) {
      next(error);
    }
  };
}
