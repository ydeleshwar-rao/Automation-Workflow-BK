import axios from "axios";
import type { PollingAdapter, PollResult } from "./adapter.interface.js";
import {
  getLocationIdByUserId,
  getValidAccessToken,
} from "../../../common/function.js";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";

type CustomFieldEntry = { id: string; name: string; dataType?: string };

// location_id → { fields, expiresAt }
const customFieldCache = new Map<
  string,
  { map: Map<string, CustomFieldEntry>; expiresAt: number }
>();
const CUSTOM_FIELD_TTL_MS = 10 * 60 * 1000;

export class LeadshubPollingAdapter implements PollingAdapter {
  async poll(
    userId: string,
    eventKey: string,
    config: Record<string, any>,
    cursorValue: string | null
  ): Promise<PollResult[]> {
    const t0 = Date.now();
    console.log(
      `[Leadhub:poll] ▶ event=${eventKey}  user=${userId}  cursor=${cursorValue === null ? "null(first-poll)" : `"${cursorValue}"`}  config=${JSON.stringify(config || {})}`
    );

    const { headers, locationId } = await this.getAuth(userId);
    console.log(`[Leadhub:poll] step 1/4 ✓ auth resolved  location=${locationId}`);

    const records = await this.fetchOpportunities(
      eventKey,
      config,
      headers,
      locationId
    );
    console.log(
      `[Leadhub:poll] step 2/4 ← /opportunities/search returned ${records.length} record(s)  filters=${JSON.stringify(
        {
          pipeline_id: config?.pipelineId,
          pipeline_stage_id: config?.pipelineStageId,
          status: config?.status,
        }
      )}`
    );

    const filtered =
      eventKey === "pipeline_stage_changed"
        ? this.filterForStageChange(records, config)
        : records;

    if (eventKey === "pipeline_stage_changed") {
      console.log(
        `[Leadhub:poll] step 3a/4 filterForStageChange  in=${records.length}  out=${filtered.length}  target_stage=${config?.pipelineStageId ?? "(any)"}`
      );
    }

    if (filtered.length === 0) {
      console.log(
        `[Leadhub:poll] ✓ no records after filter  duration=${Date.now() - t0}ms`
      );
      return [];
    }

    const enriched = await Promise.all(
      filtered.map((r) => this.enrichRecord(r, headers, locationId))
    );
    console.log(
      `[Leadhub:poll] step 3b/4 ✓ enriched ${enriched.length} record(s) (opp + contact + customFields)`
    );

    const sorted = enriched
      .map((r) => this.normalize(r, eventKey))
      .filter((r) => r.externalId && r.cursorValue)
      .sort((a, b) => a.cursorValue.localeCompare(b.cursorValue));

    const dropped = enriched.length - sorted.length;
    if (dropped > 0) {
      console.warn(
        `[Leadhub:poll] ⚠ dropped ${dropped} record(s) with missing id/cursor — check lastStageChangeAt/updatedAt presence`
      );
    }

    const afterCursor = cursorValue
      ? sorted.filter((r) => r.cursorValue.localeCompare(cursorValue) > 0)
      : sorted;

    console.log(
      `[Leadhub:poll] step 4/4 ◀ returning ${afterCursor.length} record(s)  (before_cursor_filter=${sorted.length}  newer_than_cursor=${afterCursor.length})  duration=${Date.now() - t0}ms`
    );

    return afterCursor;
  }

  async fetchSample(
    userId: string,
    eventKey: string,
    config: Record<string, any>,
    limit: number = 3
  ): Promise<Record<string, any>[]> {
    console.log(
      `[Leadhub:fetchSample] ▶ event=${eventKey}  user=${userId}  limit=${limit}  config=${JSON.stringify(config)}`
    );

    const { headers, locationId } = await this.getAuth(userId);

    let records: any[];
    try {
      records = await this.fetchOpportunities(
        eventKey,
        config,
        headers,
        locationId
      );
    } catch (err: any) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      console.error(
        `[Leadhub:fetchSample] ✖ API request failed  status=${status}  body=${JSON.stringify(body)?.slice(0, 300)}  message=${err?.message}`
      );
      throw err;
    }

    console.log(`[Leadhub:fetchSample] ← received ${records.length} record(s)`);

    const filtered =
      eventKey === "pipeline_stage_changed"
        ? this.filterForStageChange(records, config)
        : records;

    if (filtered.length === 0) {
      console.warn(
        `[Leadhub:fetchSample] ✖ zero records matched  event=${eventKey}  location=${locationId}  → verify opportunities exist in LeadsHub`
      );
      return [];
    }

    const samples = filtered
      .slice()
      .sort((a, b) => {
        const keyA =
          eventKey === "pipeline_stage_changed"
            ? a.lastStageChangeAt ?? a.updatedAt ?? a.createdAt
            : a.updatedAt ?? a.createdAt;
        const keyB =
          eventKey === "pipeline_stage_changed"
            ? b.lastStageChangeAt ?? b.updatedAt ?? b.createdAt
            : b.updatedAt ?? b.createdAt;
        return String(keyB ?? "").localeCompare(String(keyA ?? ""));
      })
      .slice(0, limit);

    const enriched = await Promise.all(
      samples.map((r) => this.enrichRecord(r, headers, locationId))
    );

    console.log(
      `[Leadhub:fetchSample] ✓ returning ${enriched.length} sample(s)  first_id=${enriched[0]?.id}`
    );
    return enriched;
  }

  private async getAuth(
    userId: string
  ): Promise<{ headers: Record<string, string>; locationId: string }> {
    const locationId = await getLocationIdByUserId(userId);
    const accessToken = await getValidAccessToken(locationId);
    if (!accessToken) {
      throw new Error(
        `[Leadhub] Access token not found for location: ${locationId}`
      );
    }
    return {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Version: "2021-07-28",
        Accept: "application/json",
      },
      locationId,
    };
  }

  private async fetchOpportunities(
    eventKey: string,
    config: Record<string, any>,
    headers: Record<string, string>,
    locationId: string
  ): Promise<any[]> {
    if (
      eventKey !== "add_update_opportunity" &&
      eventKey !== "pipeline_stage_changed"
    ) {
      throw new Error(`Unknown Leadhub event: ${eventKey}`);
    }

    const params: Record<string, any> = { location_id: locationId };
    if (config?.pipelineId) params.pipeline_id = config.pipelineId;
    if (config?.pipelineStageId) params.pipeline_stage_id = config.pipelineStageId;
    if (config?.status) params.status = config.status;

    const response = await axios.get(`${GHL_BASE_URL}/opportunities/search`, {
      headers,
      params,
    });

    return Array.isArray(response.data?.opportunities)
      ? response.data.opportunities
      : [];
  }

  private filterForStageChange(
    records: any[],
    config: Record<string, any>
  ): any[] {
    // Only keep opportunities that actually changed stage (lastStageChangeAt present)
    // and — if a target stage was configured — that currently sit in it.
    const targetStageId: string | undefined = config?.pipelineStageId;
    return records.filter((r) => {
      if (!r?.lastStageChangeAt) return false;
      if (targetStageId && r.pipelineStageId !== targetStageId) return false;
      return true;
    });
  }

  private async enrichRecord(
    record: any,
    headers: Record<string, string>,
    locationId: string
  ): Promise<Record<string, any>> {
    const opportunityId = record?.id;
    const contactId = record?.contactId ?? record?.contact?.id;

    const [fullOpp, fullContact, fieldMap] = await Promise.all([
      opportunityId
        ? this.fetchOpportunity(opportunityId, headers)
        : Promise.resolve(null),
      contactId
        ? this.fetchContact(contactId, headers)
        : Promise.resolve(null),
      this.getCustomFieldMap(locationId, headers),
    ]);

    const opp = { ...record, ...(fullOpp ?? {}) };
    const contact = { ...(record.contact ?? {}), ...(fullContact ?? {}) };

    return this.toFlatPayload(opp, contact, fieldMap);
  }

  /**
   * Collapse opportunity + contact + resolved custom fields into a single flat
   * object — one key per field, no nested `contact`, no `relations` array, no
   * provider internals (`sort`, `internalSource`, `attributions`, etc.).
   *
   * Contact fields are prefixed with `contact` so they never collide with the
   * opportunity's own fields.
   */
  private toFlatPayload(
    opp: any,
    contact: any,
    fieldMap: Map<string, CustomFieldEntry>
  ): Record<string, any> {
    const OPP_DROP = new Set([
      "contact",
      "relations",
      "sort",
      "attributions",
      "isAttribute",
      "internalSource",
      "customFields",
    ]);
    const CONTACT_DROP = new Set([
      "id",
      "locationId",
      "customFields",
      "additionalEmails",
      "additionalPhones",
      "createdBy",
      "firstNameLowerCase",
      "lastNameLowerCase",
      "fullNameLowerCase",
      "emailLowerCase",
      "score",
    ]);

    const flat: Record<string, any> = {};

    for (const [k, v] of Object.entries(opp ?? {})) {
      if (OPP_DROP.has(k)) continue;
      flat[k] = v;
    }

    for (const [k, v] of Object.entries(contact ?? {})) {
      if (CONTACT_DROP.has(k)) continue;
      flat[`contact${k.charAt(0).toUpperCase()}${k.slice(1)}`] = v;
    }

    for (const cf of this.resolveCustomFields(opp?.customFields, fieldMap) ?? []) {
      if (cf.label) flat[`cf_${this.slugify(cf.label)}`] = cf.value;
    }
    for (const cf of this.resolveCustomFields(contact?.customFields, fieldMap) ?? []) {
      if (cf.label) flat[`contactCf_${this.slugify(cf.label)}`] = cf.value;
    }

    return flat;
  }

  private slugify(label: string): string {
    return label
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
  }

  private async fetchOpportunity(
    id: string,
    headers: Record<string, string>
  ): Promise<any | null> {
    try {
      const res = await axios.get(`${GHL_BASE_URL}/opportunities/${id}`, {
        headers,
      });
      return res.data?.opportunity ?? null;
    } catch (err: any) {
      console.warn(
        `[Leadhub:enrich] ✖ opportunity fetch failed  id=${id}  status=${err?.response?.status}`
      );
      return null;
    }
  }

  private async fetchContact(
    id: string,
    headers: Record<string, string>
  ): Promise<any | null> {
    try {
      const res = await axios.get(`${GHL_BASE_URL}/contacts/${id}`, {
        headers,
      });
      return res.data?.contact ?? null;
    } catch (err: any) {
      console.warn(
        `[Leadhub:enrich] ✖ contact fetch failed  id=${id}  status=${err?.response?.status}`
      );
      return null;
    }
  }

  private async getCustomFieldMap(
    locationId: string,
    headers: Record<string, string>
  ): Promise<Map<string, CustomFieldEntry>> {
    const cached = customFieldCache.get(locationId);
    if (cached && cached.expiresAt > Date.now()) return cached.map;

    try {
      const res = await axios.get(
        `${GHL_BASE_URL}/locations/${locationId}/customFields`,
        { headers }
      );
      const fields: CustomFieldEntry[] = Array.isArray(res.data?.customFields)
        ? res.data.customFields
        : [];
      const map = new Map(fields.map((f) => [f.id, f]));
      customFieldCache.set(locationId, {
        map,
        expiresAt: Date.now() + CUSTOM_FIELD_TTL_MS,
      });
      return map;
    } catch (err: any) {
      console.warn(
        `[Leadhub:enrich] ✖ custom-field map fetch failed  location=${locationId}  status=${err?.response?.status}`
      );
      return cached?.map ?? new Map();
    }
  }

  private resolveCustomFields(
    raw: any,
    fieldMap: Map<string, CustomFieldEntry>
  ): any[] | null {
    if (!Array.isArray(raw)) return null;
    return raw.map((cf: any) => {
      const def = cf?.id ? fieldMap.get(cf.id) : undefined;
      return {
        id: cf?.id,
        label: def?.name ?? cf?.label ?? null,
        dataType: def?.dataType ?? cf?.dataType ?? null,
        value: cf?.value ?? cf?.fieldValue ?? cf?.field_value ?? null,
      };
    });
  }

  private normalize(record: any, eventKey: string): PollResult {
    if (eventKey === "pipeline_stage_changed") {
      // Composite externalId + lastStageChangeAt cursor lets the same
      // opportunity re-fire every time it re-enters the target stage.
      const stageChangeAt = String(record.lastStageChangeAt ?? "");
      return {
        externalId: `${record.id ?? ""}:${stageChangeAt}`,
        data: record,
        cursorValue: stageChangeAt,
      };
    }

    return {
      externalId: String(record.id ?? ""),
      data: record,
      // updatedAt advances on both create and update — perfect cursor for an
      // "added/updated" trigger.
      cursorValue: String(record.updatedAt ?? record.createdAt ?? ""),
    };
  }
}
