import axios from "axios";
import type { PollingAdapter, PollResult } from "./adapter.interface.js";
import { getSimproContext } from "../../initgrations/simpro/service/simpro.service.js";

/**
 * Simpro polling adapter.
 *
 * Cursor strategy: Simpro records carry `DateModified` (ISO 8601). We use it
 * as both the per-record cursor and the filter clause:
 *   GET /jobs/?DateModified=ge('2026-04-30T10:00:00Z')
 * Pagination is page-based; we walk pages until empty or the page returned
 * fewer than `pageSize` rows.
 *
 * Webhooks are preferred (see simpro.webhook.adapter.ts). Polling is the
 * safety net for tenants where the partner webhook setup hasn't been done.
 */

const PAGE_SIZE = 100;

interface QuerySpec {
  endpoint: string;                     // path under /companies/{id}/
  filter?: Record<string, string>;      // extra query filters
}

export class SimproPollingAdapter implements PollingAdapter {
  async poll(
    userId: string,
    eventKey: string,
    config: Record<string, any>,
    cursorValue: string | null
  ): Promise<PollResult[]> {
    const t0 = Date.now();
    console.log(
      `[Simpro:poll] ▶ event=${eventKey}  user=${userId}  cursor=${cursorValue ?? "null"}  config=${JSON.stringify(config)}`
    );

    const { headers, baseUrl, companyId } = await getSimproContext(userId);
    const spec = this.buildQuery(eventKey, config);

    const records = await this.fetchAll(baseUrl, companyId, headers, spec, cursorValue);
    console.log(`[Simpro:poll] ← fetched ${records.length} record(s)  duration=${Date.now() - t0}ms`);

    if (records.length === 0) return [];

    // Sort ascending by DateModified so the cursor walks forward.
    const sorted = records
      .filter((r) => this.cursorOf(r))
      .sort((a, b) => this.cursorOf(a)!.localeCompare(this.cursorOf(b)!));

    return sorted.map((r) => ({
      externalId:  String(r.ID ?? r.id ?? ""),
      data:        r,
      cursorValue: this.cursorOf(r)!,
    }));
  }

  async fetchSample(
    userId: string,
    eventKey: string,
    config: Record<string, any>,
    limit: number = 3
  ): Promise<Record<string, any>[]> {
    console.log(
      `[Simpro:fetchSample] ▶ event=${eventKey}  user=${userId}  limit=${limit}  config=${JSON.stringify(config)}`
    );

    const { headers, baseUrl, companyId } = await getSimproContext(userId);
    const spec = this.buildQuery(eventKey, config);

    // For samples we want newest first — Simpro supports orderby on DateModified.
    const url = `${baseUrl}/api/v1.0/companies/${companyId}/${spec.endpoint}`;
    const params: Record<string, any> = {
      pageSize: Math.max(1, Math.min(limit, 50)),
      page:     1,
      orderby:  "-DateModified",
      ...(spec.filter || {}),
    };

    let records: any[];
    try {
      const res = await axios.get(url, { headers, params });
      records = Array.isArray(res.data) ? res.data : [];
    } catch (err: any) {
      console.error(
        `[Simpro:fetchSample] ✖ ${url}  status=${err?.response?.status}  body=${JSON.stringify(err?.response?.data)?.slice(0, 300)}`
      );
      throw err;
    }

    console.log(`[Simpro:fetchSample] ← ${records.length} record(s)`);
    return records.slice(0, limit);
  }

  // ─── Internals ─────────────────────────────────────────────────────────
  private cursorOf(record: any): string | null {
    return record?.DateModified || record?.dateModified || record?.date_modified || null;
  }

  private async fetchAll(
    baseUrl: string,
    companyId: number,
    headers: Record<string, string>,
    spec: QuerySpec,
    cursorValue: string | null
  ): Promise<any[]> {
    const url = `${baseUrl}/api/v1.0/companies/${companyId}/${spec.endpoint}`;
    const filter = { ...(spec.filter || {}) };
    if (cursorValue) {
      // Simpro filter syntax: DateModified=gt(...) (greater-than) returns only
      // records modified after our cursor — exactly the new rows.
      filter.DateModified = `gt(${cursorValue})`;
    }

    const out: any[] = [];
    let page = 1;
    while (true) {
      const params = { ...filter, pageSize: PAGE_SIZE, page, orderby: "DateModified" };

      let res;
      try {
        res = await axios.get(url, { headers, params });
      } catch (err: any) {
        console.error(
          `[Simpro:poll] ✖ ${url}  page=${page}  status=${err?.response?.status}  body=${JSON.stringify(err?.response?.data)?.slice(0, 300)}`
        );
        throw err;
      }

      const batch = Array.isArray(res.data) ? res.data : [];
      out.push(...batch);

      if (batch.length < PAGE_SIZE) break;     // last page
      if (page >= 50) {                         // safety stop — 5000 rows max per poll
        console.warn(`[Simpro:poll] ⚠ stopped at page ${page} — safety cap reached`);
        break;
      }
      page++;
    }
    return out;
  }

  private buildQuery(eventKey: string, config: Record<string, any>): QuerySpec {
    const filter: Record<string, string> = {};

    switch (eventKey) {
      // ── Job triggers ──────────────────────────────────────────────────────
      case "new_job":
        return { endpoint: "jobs/", filter };

      case "job_stage_pending":
        filter.Stage = "Pending";
        return { endpoint: "jobs/", filter };

      case "job_stage_in_progress":
        filter.Stage = "In Progress";
        return { endpoint: "jobs/", filter };

      case "job_completed":
      case "job_stage_complete":
        filter.Stage = "Complete";
        return { endpoint: "jobs/", filter };

      case "job_stage_invoiced":
        filter.Stage = "Invoiced";
        return { endpoint: "jobs/", filter };

      case "job_stage_archived":
        filter.Stage = "Archived";
        return { endpoint: "jobs/", filter };

      case "job_status_changed":
        if (config?.status_filter) filter.Stage = config.status_filter;
        return { endpoint: "jobs/", filter };

      // ── Quote triggers ────────────────────────────────────────────────────
      case "new_quote":
        return { endpoint: "quotes/", filter };

      case "quote_accepted":
        filter.Stage = "Accepted";
        return { endpoint: "quotes/", filter };

      case "quote_status_changed":
        return { endpoint: "quotes/", filter };

      // ── Customer triggers ─────────────────────────────────────────────────
      case "new_company_customer":
      case "new_customer":
      case "new_client":
        return { endpoint: "customers/companies/", filter };

      case "new_individual_customer":
        return { endpoint: "customers/individuals/", filter };

      // ── Lead triggers ─────────────────────────────────────────────────────
      case "new_lead":
        return { endpoint: "leads/", filter };

      case "lead_status_changed":
        return { endpoint: "leads/", filter };

      // ── Invoice / Payment triggers ────────────────────────────────────────
      case "invoice_created":
      case "new_invoice":
        return { endpoint: "invoices/", filter };

      case "payment_received":
        return { endpoint: "receipts/", filter };

      // ── Update triggers ───────────────────────────────────────────────────
      case "company_customer_updated":
        return { endpoint: "customers/companies/", filter };

      case "individual_customer_updated":
        return { endpoint: "customers/individuals/", filter };

      case "job_updated":
        return { endpoint: "jobs/", filter };

      case "quote_updated":
        return { endpoint: "quotes/", filter };

      // ── Schedule triggers ─────────────────────────────────────────────────
      case "new_schedule":
      case "schedule_updated":
        return { endpoint: "schedules/", filter };

      // ── Site triggers ─────────────────────────────────────────────────────
      case "new_site":
      case "site_updated":
        return { endpoint: "sites/", filter };

      default:
        throw new Error(`[Simpro:poll] unknown event_key: ${eventKey}`);
    }
  }
}
