import axios from "axios";
import type { PollingAdapter, PollResult } from "./adapter.interface.js";
import { getParams } from "../../initgrations/commusoft/service/commusoft.service.js";

const COMMUSOFT_BASE_URL =
  "https://app.commusoft.co.uk/webservice_dev.php/api/v1";

interface QueryConfig {
  endpoint: string;
  query: Record<string, string>;
}

function opportunityIdOf(record: any): string | null {
  const raw =
    record?.opportunityId ??
    record?.opportunity_id ??
    record?.["Opportunity Id"] ??
    record?.["Opportunity ID"] ??
    record?.id ??
    record?.ID;

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }

  return String(raw).trim();
}

const COMMUSOFT_STAGE_TRIGGER_KEYS = new Set([
  "proposal_sent",
  "proposal_accepted",
  "opportunity_stage_changed",
]);

const COMMUSOFT_ESTIMATE_TRIGGER_KEYS = new Set([
  "estimate_sent",
  "estimate_accepted",
  "estimate_rejected",
]);

export class CommusoftPollingAdapter implements PollingAdapter {
  async poll(
    userId: string,
    eventKey: string,
    config: Record<string, any>,
    cursorValue: string | null
  ): Promise<PollResult[]> {
    const t0 = Date.now();
    console.log(
      `[Commusoft:poll] ▶ event=${eventKey}  user=${userId}  cursor=${cursorValue === null ? "null" : `"${cursorValue}"`}  config=${JSON.stringify(config)}`
    );

    let params: Awaited<ReturnType<typeof getParams>>;
    try {
      params = await getParams(userId);
    } catch (err: any) {
      console.error(
        `[Commusoft:poll] ✖ credential resolution failed  user=${userId}  error=${err?.message}`
      );
      throw err;
    }

    const { endpoint, query } = this.buildQuery(eventKey, config);
    const url = `${COMMUSOFT_BASE_URL}/${endpoint}`;
    console.log(
      `[Commusoft:poll] → GET ${url}  query=${JSON.stringify(query)}`
    );

    let response;
    try {
      response = await axios.get(url, { params: { ...params, ...query } });
    } catch (err: any) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      console.error(
        `[Commusoft:poll] ✖ API request failed  status=${status}  body=${JSON.stringify(body)?.slice(0, 300)}  message=${err?.message}  duration=${Date.now() - t0}ms`
      );
      throw err;
    }

    let records = COMMUSOFT_ESTIMATE_TRIGGER_KEYS.has(eventKey)
      ? this.extractEstimateRecords(response.data)
      : this.extractRecords(response.data);
    if (COMMUSOFT_STAGE_TRIGGER_KEYS.has(eventKey)) {
      records = await this.enrichProposalRecords(params, eventKey, records);
      records = await this.appendNearbyProposalRecords(params, eventKey, records, config);
      records = this.filterProposalRecords(eventKey, records);
    }
    console.log('[Commusoft] Raw record fields:', Object.keys(records[0] || {}));
    console.log('[Commusoft] Raw record sample:', JSON.stringify(records[0], null, 2));
    if (records.length === 0) return [];

    const normalized = records.map((r) => this.normalize(r, eventKey));
    const droppedNoId = normalized.filter((r) => !r.externalId).length;
    if (droppedNoId > 0) {
      // If this triggers, Commusoft returned records whose id fields don't
      // match any of our normalize() fallbacks — worth adding a new key there.
      console.warn(
        `[Commusoft:poll] ⚠ dropped ${droppedNoId} record(s) with empty externalId — sample keys=${Object.keys(records[0] ?? {}).join(",").slice(0, 200)}`
      );
    }

    const sorted = normalized
      .filter((r) => r.externalId)
      .sort((a, b) => a.cursorValue.localeCompare(b.cursorValue));

    console.log('[Commusoft] Returning records:', sorted.map(r => ({
      externalId: r.externalId,
      cursorValue: r.cursorValue,
      jobNumber: r.data['Job Number'],
      jobUuid: r.data['Job Uuid'],
    })));

    return sorted;
  }

  async fetchSample(
    userId: string,
    eventKey: string,
    config: Record<string, any>,
    limit: number = 3
  ): Promise<Record<string, any>[]> {
    console.log(
      `[Commusoft:fetchSample] ▶ event=${eventKey}  user=${userId}  limit=${limit}  config=${JSON.stringify(config)}`
    );

    const params = await getParams(userId);
    const { endpoint, query } = this.buildQuery(eventKey, config);

    const url = `${COMMUSOFT_BASE_URL}/${endpoint}`;
    console.log(
      `[Commusoft:fetchSample] → GET ${url}  query=${JSON.stringify(query)}`
    );

    let response;
    try {
      response = await axios.get(url, { params: { ...params, ...query } });
    } catch (err: any) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      console.error(
        `[Commusoft:fetchSample] ✖ API request failed  status=${status}  body=${JSON.stringify(body)?.slice(0, 300)}  message=${err?.message}`
      );
      throw err;
    }

    let records = COMMUSOFT_ESTIMATE_TRIGGER_KEYS.has(eventKey)
      ? this.extractEstimateRecords(response.data)
      : this.extractRecords(response.data);
    if (COMMUSOFT_STAGE_TRIGGER_KEYS.has(eventKey)) {
      records = await this.enrichProposalRecords(params, eventKey, records);
      records = await this.appendNearbyProposalRecords(params, eventKey, records, config);
      records = this.filterProposalRecords(eventKey, records);
    }
    console.log(
      `[Commusoft:fetchSample] ← received ${records.length} record(s)`
    );

    if (records.length === 0) {
      console.warn(
        `[Commusoft:fetchSample] ✖ zero records matched  event=${eventKey}  query=${JSON.stringify(query)}`
      );
      return [];
    }

    const samples = records
      .slice()
      .sort((a, b) => this.compareNewestFirst(a, b))
      .slice(0, limit);

    console.log(
      `[Commusoft:fetchSample] ✓ returning ${samples.length} sample(s)`
    );
    if (COMMUSOFT_STAGE_TRIGGER_KEYS.has(eventKey) || COMMUSOFT_ESTIMATE_TRIGGER_KEYS.has(eventKey)) {
      return samples.map((sample) => this.normalize(sample, eventKey).data);
    }

    return samples;
  }

  /** Format an ISO timestamp (or any Date-parseable string) as YYYY-MM-DD. */
  private toYMD(iso: string): string {
    const d = new Date(iso);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  /** Format an ISO timestamp as yyyy-MM-ddThh:mm:ss (Commusoft customers API). */
  private toDateTimeLocal(iso: string): string {
    const d = new Date(iso);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mi = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
  }

  private applyJobDateRange(
    query: Record<string, string>,
    config: Record<string, any>
  ): void {
    const startIso = config?._subscriptionCreatedAt;
    if (startIso) {
      query.jobCreatedStartDate = this.toYMD(startIso);
    }
    query.jobCreatedEndDate = this.toYMD(new Date().toISOString());
  }

  private buildQuery(
    eventKey: string,
    config: Record<string, any>
  ): QueryConfig {
    const query: Record<string, string> = {};

    console.log(
      `[Commusoft:buildQuery] ▶ trigger=${eventKey}  config=${JSON.stringify(config)}`
    );

    switch (eventKey) {
      case "job_completed":
        query.status = "completed";
        if (config?.priority) query.priority = String(config.priority);
        if (config?.customerID) query.customerID = String(config.customerID);
        this.applyJobDateRange(query, config);
        console.log(`[Commusoft:buildQuery] job_completed → GET /jobs  query=${JSON.stringify(query)}`);
        return { endpoint: "jobs", query };

      case "job_closed":
        query.status = config?.status ? String(config.status) : "on_hold";
        if (config?.priority) query.priority = String(config.priority);
        if (config?.customerID) query.customerID = String(config.customerID);
        this.applyJobDateRange(query, config);
        console.log(`[Commusoft:buildQuery] job_closed → GET /jobs  query=${JSON.stringify(query)}`);
        return { endpoint: "jobs", query };

      case "new_job":
        query.status = config?.status ? String(config.status) : "ongoing";
        if (config?.priority)   query.priority   = String(config.priority);
        if (config?.customerID) query.customerID = String(config.customerID);
        this.applyJobDateRange(query, config);
        console.log(`[Commusoft:buildQuery] new_job → GET /jobs  query=${JSON.stringify(query)}`);
        return { endpoint: "jobs", query };

      case "new_client": {
        const startIso = config?._subscriptionCreatedAt;
        if (startIso) {
          query.createdondatetime_after = this.toDateTimeLocal(startIso);
        }
        console.log(`[Commusoft:buildQuery] new_client → GET /customers  query=${JSON.stringify(query)}`);
        return { endpoint: "customers", query };
      }

      case "proposal_sent":
      case "proposal_accepted":
      case "opportunity_stage_changed": {
        const stageId = this.resolveStageId(config);
        if (!stageId) {
          throw new Error(
            `Commusoft ${eventKey} trigger requires config.stageId, config.commusoftStageId, or config.opportunityStageId`
          );
        }

        if (config?.searchText) query.searchText = String(config.searchText);
        if (config?.salesPersonId) query.salesPersonId = String(config.salesPersonId);
        if (config?.lowValue ?? config?.lowPrice) {
          query.lowValue = String(config.lowValue ?? config.lowPrice);
        }
        if (config?.highValue ?? config?.highPrice) {
          query.highValue = String(config.highValue ?? config.highPrice);
        }
        if (config?.page) query.page = String(config.page);
        if (config?.limit) query.limit = String(config.limit);

        console.log(
          `[Commusoft:buildQuery] ${eventKey} → GET /sales/${stageId}/stageopportunities  query=${JSON.stringify(query)}`
        );
        return { endpoint: `sales/${stageId}/stageopportunities`, query };
      }

      case "estimate_sent":
      case "estimate_accepted":
      case "estimate_rejected": {
        const defaultStatus =
          eventKey === "estimate_sent"
            ? "waiting_for_customer"
            : eventKey === "estimate_accepted"
            ? "accepted"
            : "rejected";

        query.status = config?.status ? String(config.status) : defaultStatus;
        if (config?.searchText) query.searchText = String(config.searchText);
        if (config?.id ?? config?.customerID ?? config?.customerId ?? config?.estimateId) {
          query.id = String(config.id ?? config.customerID ?? config.customerId ?? config.estimateId);
        }
        if (config?.limit) query.limit = String(config.limit);

        console.log(
          `[Commusoft:buildQuery] ${eventKey} → GET /alloutstandingjobsandestimate  query=${JSON.stringify(query)}`
        );
        return { endpoint: "alloutstandingjobsandestimate", query };
      }

      default:
        console.error(`[Commusoft:buildQuery] ✖ unknown trigger="${eventKey}"`);
        throw new Error(`Unknown Commusoft event: ${eventKey}`);
    }
  }

  private extractRecords(body: any): any[] {
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.Jobs)) return body.Jobs;
    if (Array.isArray(body?.jobs)) return body.jobs;
    if (Array.isArray(body?.Customers)) return body.Customers;
    if (Array.isArray(body?.customers)) return body.customers;
    if (Array.isArray(body?.Opportunities)) return body.Opportunities;
    if (Array.isArray(body?.opportunities)) return body.opportunities;
    if (Array.isArray(body?.Opportunity)) return body.Opportunity;
    if (Array.isArray(body?.opportunity)) return body.opportunity;
    if (Array.isArray(body?.details)) return body.details;
    if (Array.isArray(body?.data)) return body.data;
    if (Array.isArray(body?.data?.jobs)) return body.data.jobs;
    if (Array.isArray(body?.data?.customers)) return body.data.customers;
    if (Array.isArray(body?.data?.opportunities)) return body.data.opportunities;
    if (Array.isArray(body?.data?.Opportunities)) return body.data.Opportunities;
    if (Array.isArray(body?.data?.details)) return body.data.details;
    return [];
  }

  private async enrichProposalRecords(
    params: Awaited<ReturnType<typeof getParams>>,
    eventKey: string,
    records: any[]
  ): Promise<any[]> {
    if (!["proposal_sent", "proposal_accepted"].includes(eventKey)) {
      return records;
    }

    return Promise.all(
      records.map(async (record) => {
        const opportunityId = opportunityIdOf(record);

        if (!opportunityId) return record;

        try {
          const response = await axios.get(
            `${COMMUSOFT_BASE_URL}/opportunitydetails/${opportunityId}`,
            { params }
          );
          return this.withProposalDetailAliases(record, response.data);
        } catch (err: any) {
          console.warn(
            `[Commusoft:proposal] could not enrich opportunity ${opportunityId}: ${err?.response?.status ?? err?.message}`
          );
          return record;
        }
      })
    );
  }

  private filterProposalRecords(eventKey: string, records: any[]): any[] {
    if (eventKey === "proposal_sent") {
      return records.filter((record) => this.isProposalSent(record));
    }

    if (eventKey === "proposal_accepted") {
      return records.filter((record) => this.isProposalAccepted(record));
    }

    return records;
  }

  private async appendNearbyProposalRecords(
    params: Awaited<ReturnType<typeof getParams>>,
    eventKey: string,
    records: any[],
    config: Record<string, any>
  ): Promise<any[]> {
    if (!["proposal_sent", "proposal_accepted"].includes(eventKey)) {
      return records;
    }

    const explicitIds = this.parseOpportunityIds(config);
    const maxScanned = Math.min(
      Math.max(Number(config?.opportunityIdScanLimit ?? 100) || 100, 0),
      100
    );
    const knownIds = records
      .map((record) => opportunityIdOf(record))
      .filter((id): id is string => Boolean(id));
    const numericKnownIds = knownIds
      .map((id) => Number.parseInt(id, 10))
      .filter((id) => Number.isFinite(id));
    const maxKnownId = numericKnownIds.length > 0 ? Math.max(...numericKnownIds) : null;
    const nearbyIds =
      maxKnownId && maxScanned > 0
        ? Array.from({ length: maxScanned }, (_, index) => String(maxKnownId + index + 1))
        : [];
    const idsToFetch = [
      ...new Set([...explicitIds, ...nearbyIds].filter((id) => !knownIds.includes(id))),
    ];

    if (idsToFetch.length === 0) return records;

    console.log(
      `[Commusoft:proposal] probing ${idsToFetch.length} opportunity detail id(s) not returned by stage list`
    );

    const detailRecords: any[] = [];
    for (const opportunityId of idsToFetch) {
      try {
        const response = await axios.get(
          `${COMMUSOFT_BASE_URL}/opportunitydetails/${opportunityId}`,
          { params }
        );
        detailRecords.push(
          this.withProposalDetailAliases(
            { opportunityId: Number.isFinite(Number(opportunityId)) ? Number(opportunityId) : opportunityId },
            response.data
          )
        );
      } catch (err: any) {
        const status = err?.response?.status;
        if (status && [400, 404, 410, 500].includes(status)) {
          continue;
        }
        console.warn(
          `[Commusoft:proposal] detail probe failed opportunity=${opportunityId}: ${status ?? err?.message}`
        );
      }
    }

    if (detailRecords.length === 0) return records;

    const merged = new Map<string, any>();
    for (const record of [...records, ...detailRecords]) {
      const id = opportunityIdOf(record);
      if (id) merged.set(id, record);
    }
    return [...merged.values()];
  }

  private parseOpportunityIds(config: Record<string, any>): string[] {
    const raw =
      config?.opportunityIds ??
      config?.opportunity_ids ??
      config?.opportunityId ??
      config?.opportunity_id;

    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw.map((value) => String(value).trim()).filter(Boolean);
    }
    return String(raw)
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private compareNewestFirst(a: any, b: any): number {
    const aId = Number.parseInt(opportunityIdOf(a) ?? "", 10);
    const bId = Number.parseInt(opportunityIdOf(b) ?? "", 10);
    const aHasId = Number.isFinite(aId);
    const bHasId = Number.isFinite(bId);

    if (aHasId && bHasId && aId !== bId) return bId - aId;

    const aTime = Date.parse(this.cursorOf(a));
    const bTime = Date.parse(this.cursorOf(b));
    const aHasTime = Number.isFinite(aTime);
    const bHasTime = Number.isFinite(bTime);

    if (aHasTime && bHasTime && aTime !== bTime) return bTime - aTime;
    if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
    if (aHasId !== bHasId) return aHasId ? -1 : 1;

    return this.cursorOf(b).localeCompare(this.cursorOf(a));
  }

  private isProposalSent(record: any): boolean {
    const mailSendCount = Number(record.mailSendCount ?? 0);
    const lastCommunicationType = String(record.lastCommunicationType ?? "").toLowerCase();

    return Boolean(
      record.proposalSent === 1 ||
        record.proposalSent === true ||
        mailSendCount > 0 ||
        record.lastProposalSentVersion ||
        this.isProposalAccepted(record) ||
        (lastCommunicationType.includes("email") && record.lastCommunicationDate)
    );
  }

  private isProposalAccepted(record: any): boolean {
    const statusText = [
      record.proposalStatus,
      record.proposalTemplateStatus,
      record.status,
      record.acceptStatus,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase())
      .join(" ");

    return Boolean(
      record.proposalAcceptedAt ||
        record.acceptedJobId ||
        statusText.includes("accepted") ||
        statusText.includes("won") ||
        statusText.includes("waiting_for_job_to_start")
    );
  }

  private withProposalDetailAliases(
    record: Record<string, any>,
    details: Record<string, any>
  ): Record<string, any> {
    const accepted = Array.isArray(details.acceptOpportunity)
      ? details.acceptOpportunity[0]
      : undefined;
    const option = Array.isArray(details.proposalOptions)
      ? details.proposalOptions[0]
      : undefined;

    return {
      ...record,
      customerName:
        record.customerName ??
        details.customerData?.customerName ??
        details.customerContact?.customerContactName,
      contactName:
        record.contactName ??
        details.customerContact?.customerContactName ??
        details.customerData?.customerName,
      email:
        record.email ??
        details.customerContact?.contactEmail ??
        details.customerData?.emailaddress,
      phone:
        record.phone ??
        details.customerContact?.contactTelephone2 ??
        details.customerData?.landLine,
      opportunityName:
        record.opportunityName ??
        details.opportunityTemplateData?.templateName ??
        record.Title,
      proposalSent: details.proposalSent ?? record.proposalSent,
      proposalStatus:
        details.proposalStatus ??
        details.proposalTemplateData?.status ??
        record.proposalStatus,
      proposalTemplateStatus: details.proposalTemplateData?.status,
      acceptStatus: record.acceptStatus ?? details.acceptStatus,
      mailSendCount:
        details.proposalTemplateData?.mailSendCount ?? record.mailSendCount,
      lastProposalSentVersion:
        details.lastProposalSentVersion ?? record.lastProposalSentVersion,
      proposalAcceptedAt:
        accepted?.acceptOpportunity ??
        accepted?.acceptOpportunityDate?.date ??
        record.proposalAcceptedAt,
      acceptedJobId: accepted?.acceptOpportunityJobId ?? record.acceptedJobId,
      proposalUpdatedAt:
        details.updatedAt ??
        details.updated_at ??
        details.lastUpdated ??
        details.last_updated ??
        details.proposalUpdatedAt ??
        details.proposal_updated_at ??
        details.lastProposalUpdatedAt ??
        details.lastProposalUpdatedAt?.date ??
        details.opportunityTemplateData?.updatedAt ??
        details.opportunityTemplateData?.updated_at ??
        details.opportunityTemplateData?.createdAt ??
        details.opportunityTemplateData?.created_at ??
        record.proposalUpdatedAt,
      selectedOptionName:
        option?.customerOptionName ?? option?.optionName ?? record.selectedOptionName,
      proposalValue:
        option?.finalSalePrice ??
        option?.total ??
        details.priceRange?.max ??
        record.proposalValue,
      monetaryValue:
        option?.finalSalePrice ??
        option?.total ??
        details.priceRange?.max ??
        record.monetaryValue ??
        record.max ??
        record.min,
      proposalPDFLink: details.proposalPDFLink ?? record.proposalPDFLink,
    };
  }

  private extractEstimateRecords(body: any): any[] {
    const candidates = [
      body,
      body?.data,
      body?.details,
      body?.records,
      body?.items,
      body?.estimates,
      body?.Estimates,
      body?.Estimate,
      body?.estimate,
      body?.data?.details,
      body?.data?.records,
      body?.data?.items,
      body?.data?.estimates,
      body?.data?.Estimates,
      body?.outstanding,
      body?.data?.outstanding,
    ];

    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) continue;
      const estimates = candidate.filter((record) => this.hasEstimateSignal(record));
      if (estimates.length > 0) return estimates;
    }

    return [];
  }

  private hasEstimateSignal(record: any): boolean {
    if (!record || typeof record !== "object") return false;

    const type = String(
      record.type ??
        record.Type ??
        record.recordType ??
        record.record_type ??
        record["Record Type"] ??
        record["Type"] ??
        ""
    ).toLowerCase();

    if (type.includes("estimate")) return true;

    return Boolean(
      record.estimateId ??
        record.estimateID ??
        record.estimateid ??
        record.estimate_id ??
        record["Estimate Id"] ??
        record["Estimate ID"] ??
        record["Estimate Number"] ??
        record["Estimate No"] ??
        record["Estimate UUID"] ??
        record["Estimate Uuid"]
    );
  }

  private normalize(record: any, eventKey: string): PollResult {
    // Commusoft /jobs returns keys like "Job Uuid", "jobId", "Job Number"
    // (bracket access needed for spaces/capitals). Other endpoints + future
    // shapes keep the legacy fallbacks.
    const baseExternalId = String(
      record["Opportunity Uuid"] ??
        record["Opportunity UUID"] ??
      record["Opportunity Id"] ??
        record["Opportunity ID"] ??
        record["Estimate Uuid"] ??
        record["Estimate UUID"] ??
        record["Estimate Id"] ??
        record["Estimate ID"] ??
        record.estimateUuid ??
        record.estimate_uuid ??
        record.estimateId ??
        record.estimateID ??
        record.estimate_id ??
        record.estimateid ??
        record.opportunityUuid ??
        record.opportunity_uuid ??
        record.opportunityId ??
        record.opportunity_id ??
        record.ID ??
        record.Id ??
        record['Job Uuid'] ??
        record['job_uuid'] ??
        record.jobId ??
        record.uuid ??
        record.id ??
        ""
    );

    const data = COMMUSOFT_STAGE_TRIGGER_KEYS.has(eventKey)
      ? this.withOpportunityAliases(record, eventKey, baseExternalId)
      : COMMUSOFT_ESTIMATE_TRIGGER_KEYS.has(eventKey)
      ? this.withEstimateAliases(record, eventKey, baseExternalId)
      : record;
    const externalId = this.externalIdForEvent(baseExternalId, eventKey, data);

    return {
      externalId,
      data,
      cursorValue: this.cursorOf(record),
    };
  }

  private externalIdForEvent(
    baseExternalId: string,
    eventKey: string,
    data: Record<string, any>
  ): string {
    if (!COMMUSOFT_STAGE_TRIGGER_KEYS.has(eventKey)) return baseExternalId;

    if (eventKey === "proposal_sent") {
      const version =
        data.lastProposalSentVersion ??
        data.proposalUpdatedAt ??
        data.lastCommunicationDate ??
        data.proposalPDFLink ??
        data.monetaryValue ??
        "sent";
      return `${baseExternalId}:proposal_sent:${version}`;
    }

    if (eventKey === "proposal_accepted") {
      const acceptedMarker =
        data.proposalAcceptedAt ??
        data.acceptedJobId ??
        data.proposalStatus ??
        data.acceptStatus ??
        "accepted";
      return `${baseExternalId}:proposal_accepted:${acceptedMarker}`;
    }

    return `${baseExternalId}:${eventKey}:${this.cursorOf(data) || "stage"}`;
  }

  private cursorOf(record: any): string {
    const raw =
      record.proposalAcceptedAt ??
      record.proposalUpdatedAt ??
      record.acceptOpportunityDate ??
      record.acceptOpportunity ??
      record.lastCommunicationDate ??
      record.lastProposalSentVersion ??
      record.opportunityProposalDate ??
      record['Completed Date'] ??
      record["Updated Date"] ??
      record["Last Updated"] ??
      record["Created Date"] ??
      record.updatedAt ??
      record.updated_at ??
      record.createdAt ??
      record.created_at ??
      record.date ??
      record.Date ??
      record["Estimate Date"] ??
      record["Estimate Created Date"] ??
      record["Estimate Id"] ??
      record["Estimate ID"] ??
      record.estimateId ??
      record.estimate_id ??
      record.estimateid ??
      record['Job Date'] ??
      record['jobId'] ??
      record.opportunityId ??
      record.opportunity_id ??
      record['Job Uuid'] ??
      record.id ??
      "";

    if (!raw) return "";
    const cursorRaw = typeof raw === "object" && raw?.date ? raw.date : raw;

    // Convert DD/MM/YY → ISO timestamp for proper string comparison
    const ddmmyy = String(cursorRaw).match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
    if (ddmmyy) {
      const [, dd, mm, yy] = ddmmyy;
      return `20${yy}-${mm}-${dd}T00:00:00.000Z`;
    }

    return String(cursorRaw);
  }

  private resolveStageId(config: Record<string, any>): string | null {
    const raw =
      config?.commusoftStageId ??
      config?.opportunityStageId ??
      config?.stageId ??
      config?.stage_id;

    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return null;
    }

    return String(raw).trim();
  }

  private withOpportunityAliases(
    record: Record<string, any>,
    eventKey: string,
    externalId: string
  ): Record<string, any> {
    const customerName =
      record.customerName ??
      record.customer_name ??
      record["Customer Name"] ??
      record["Customer"] ??
      record.name ??
      record.Name;

    const contactName =
      record.contactName ??
      record.contact_name ??
      record["Contact Name"] ??
      customerName;

    const email =
      record.email ??
      record.Email ??
      record["Email"] ??
      record["Email Address"] ??
      record.contactEmail ??
      record.contact_email;

    const phone =
      record.phone ??
      record.Phone ??
      record["Phone"] ??
      record["Telephone"] ??
      record["Mobile"] ??
      record.contactPhone ??
      record.contact_phone;

    const opportunityName =
      record.opportunityName ??
      record.opportunity_name ??
      record["Opportunity Name"] ??
      record["Description"] ??
      customerName ??
      externalId;

    const monetaryValue = this.parseMoney(
      record.monetaryValue ??
        record.opportunityValue ??
        record.opportunity_value ??
        record.quoteValue ??
        record.quote_value ??
        record.proposalValue ??
        record.proposal_value ??
        record.max ??
        record.min ??
        record["Monetary Value"] ??
        record["Opportunity Value"] ??
        record["Quote Value"] ??
        record["Proposal Value"] ??
        record["Total Value"] ??
        record["Value"] ??
        record.value ??
        record.total
    );

    const { firstName, lastName } = this.splitName(contactName);

    return {
      ...record,
      __integration: "commusoft",
      __event_key: eventKey,
      __external_id: externalId,
      __legacy_external_id: externalId,
      commusoft_opportunity_id: externalId,
      opportunityId: record.opportunityId ?? record.opportunity_id ?? externalId,
      opportunityName,
      firstName,
      lastName,
      customerName,
      contactName,
      email,
      phone,
      monetaryValue,
      opportunityValue: monetaryValue,
      quoteValue: monetaryValue,
    };
  }

  private withEstimateAliases(
    record: Record<string, any>,
    eventKey: string,
    externalId: string
  ): Record<string, any> {
    const customerName =
      record.customerName ??
      record.customer_name ??
      record["Customer Name"] ??
      record["Customer"] ??
      record.customer ??
      record.name ??
      record.Name;

    const contactName =
      record.contactName ??
      record.contact_name ??
      record["Contact Name"] ??
      customerName;

    const email =
      record.email ??
      record.Email ??
      record["Email"] ??
      record["Email Address"] ??
      record.contactEmail ??
      record.contact_email;

    const phone =
      record.phone ??
      record.Phone ??
      record["Phone"] ??
      record["Telephone"] ??
      record["Mobile"] ??
      record.contactPhone ??
      record.contact_phone;

    const estimateNumber =
      record.estimateNumber ??
      record.estimate_number ??
      record["Estimate Number"] ??
      record["Estimate No"] ??
      record["Record no"] ??
      record["Record No"];

    const estimateName =
      record.estimateName ??
      record.estimate_name ??
      record["Estimate Name"] ??
      record["Description"] ??
      record.description ??
      (estimateNumber ? `Estimate ${estimateNumber}` : customerName ?? externalId);

    const estimateStatus =
      record.estimateStatus ??
      record.estimate_status ??
      record.status ??
      record.Status ??
      record.optionstatus ??
      record["Status"];

    const monetaryValue = this.parseMoney(
      record.monetaryValue ??
        record.estimateValue ??
        record.estimate_value ??
        record.quoteValue ??
        record.quote_value ??
        record.totalValue ??
        record.total_value ??
        record["Estimate Value"] ??
        record["Estimate Total"] ??
        record["Total Value"] ??
        record["Total"] ??
        record["Value"] ??
        record.value ??
        record.total
    );

    const { firstName, lastName } = this.splitName(contactName);

    return {
      ...record,
      __integration: "commusoft",
      __event_key: eventKey,
      __external_id: externalId,
      commusoft_estimate_id: externalId,
      estimateId: record.estimateId ?? record.estimate_id ?? record.estimateid ?? externalId,
      estimateNumber,
      estimateName,
      estimateStatus,
      opportunityName: estimateName,
      firstName,
      lastName,
      customerName,
      contactName,
      email,
      phone,
      monetaryValue,
      estimateValue: monetaryValue,
      quoteValue: monetaryValue,
      value: monetaryValue,
    };
  }

  private parseMoney(raw: any): number | undefined {
    if (raw === undefined || raw === null || raw === "") return undefined;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;

    const cleaned = String(raw).replace(/[^\d.-]/g, "");
    if (!cleaned) return undefined;

    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private splitName(raw: any): { firstName?: string; lastName?: string } {
    if (!raw || typeof raw !== "string") return {};
    const parts = raw.trim().replace(/^(Mr|Mrs|Miss|Ms|Dr)\.?\s+/i, "").split(/\s+/);
    if (parts.length === 0) return {};
    if (parts.length === 1) {
      return parts[0] ? { firstName: parts[0] } : {};
    }

    const lastName = parts[parts.length - 1];
    const result: { firstName?: string; lastName?: string } = {
      firstName: parts.slice(0, -1).join(" "),
    };
    if (lastName) result.lastName = lastName;

    return result;
  }
}
