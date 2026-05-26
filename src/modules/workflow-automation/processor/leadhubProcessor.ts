import axios from "axios";
import { getValidAccessToken, getLocationIdByUserId } from "../../../common/function.js";
import { createContact } from "../../leadshub/contacts/service/contacts.service.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LeadhubActionInput {
  // Contact fields
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  source?: string;
  [key: string]: any;

  // Opportunity fields (set via static mappings in workflow config)
  pipelineId?: string;
  pipelineStageId?: string;
  opportunityName?: string;
  opportunityStatus?: string;
  monetaryValue?: number | string;
  opportunityValue?: number | string;
  quoteValue?: number | string;

  // Resolved from node config
  locationId?: string;
}

interface LeadhubActionResult {
  contactId: string;
  contactCreated: boolean;
  opportunityId: string | null;
  opportunityAction: "created" | "updated" | "skipped";
  tagsApplied?: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw === 'No Numbers Saved') return undefined;
  let cleaned = raw.replace(/\s+/g, '');
  // Fix "+440XXXXXXXX" → "+44XXXXXXXX" (remove leading 0 after country code)
  cleaned = cleaned.replace(/^(\+\d{2})0/, '$1');
  if (cleaned.startsWith('0')) {
    cleaned = '+44' + cleaned.slice(1);
  }
  if (/^\d{10}$/.test(cleaned)) {
    cleaned = '+44' + cleaned;
  }
  return cleaned;
}

function parseMoney(raw: any): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;

  const cleaned = String(raw).replace(/[^\d.-]/g, "");
  if (!cleaned) return undefined;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTags(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  const values = Array.isArray(raw) ? raw : String(raw).split(",");

  return Array.from(
    new Set(
      values
        .map((tag) => String(tag).trim())
        .filter(Boolean)
    )
  );
}

function normalizePhoneForCompare(raw: unknown): string {
  return String(raw ?? "").replace(/[^\d+]/g, "");
}

function opportunityMatchesContact(
  opportunity: any,
  contactId: string,
  contactFields: Record<string, any>
): boolean {
  const opportunityContactId =
    opportunity.contactId ??
    opportunity.contact_id ??
    opportunity.contact?.id ??
    opportunity.contact?.contactId;
  if (opportunityContactId && String(opportunityContactId) === String(contactId)) {
    return true;
  }

  const targetEmail = String(contactFields.email ?? "").toLowerCase();
  const targetPhone = normalizePhoneForCompare(contactFields.phone);
  const opportunityEmail = String(
    opportunity.contact?.email ??
      opportunity.contactEmail ??
      opportunity.contact_email ??
      ""
  ).toLowerCase();
  const opportunityPhone = normalizePhoneForCompare(
    opportunity.contact?.phone ??
      opportunity.contactPhone ??
      opportunity.contact_phone
  );

  return Boolean(
    (targetEmail && opportunityEmail === targetEmail) ||
      (targetPhone && opportunityPhone === targetPhone)
  );
}

function pipelineIdOf(opportunity: any): string {
  return String(opportunity.pipelineId ?? opportunity.pipeline_id ?? "");
}

function contactDisplayName(contactFields: Record<string, any>): string | undefined {
  const fromFullName =
    contactFields.contactName ??
    contactFields.customerName ??
    contactFields.fullContactName ??
    contactFields.name;

  if (fromFullName && String(fromFullName).trim()) {
    return String(fromFullName).trim();
  }

  const firstLast = [contactFields.firstName, contactFields.lastName]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join(" ");

  return firstLast || undefined;
}

function resolveOpportunityName(
  opportunityName: unknown,
  contactFields: Record<string, any>,
  fallback: string
): string {
  const providedName = opportunityName ? String(opportunityName).trim() : "";
  const contactName = contactDisplayName(contactFields);

  // Commusoft proposal names often describe the quote/template, but GHL
  // pipeline cards are easier to operate when they show the customer name.
  if (contactName && (!providedName || /\b(estimate|proposal|quote)\b/i.test(providedName))) {
    return contactName;
  }

  return providedName || contactName || fallback;
}

async function searchOpportunities(
  accessToken: string,
  params: Record<string, string | number | undefined>
): Promise<any[]> {
  const searchUrl = "https://services.leadconnectorhq.com/opportunities/search";
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      searchParams.set(key, String(value));
    }
  });

  const response = await axios.get(searchUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
    params: Object.fromEntries(searchParams.entries()),
  });

  const opportunities = response.data?.opportunities ?? [];
  console.log(
    `[Leadhub] search params=${JSON.stringify(Object.fromEntries(searchParams.entries()))} returned=${opportunities.length}`
  );
  return opportunities;
}

async function addTagsToContact(
  accessToken: string,
  contactId: string,
  tags: string[]
): Promise<void> {
  if (tags.length === 0) return;

  const tagUrl = `https://services.leadconnectorhq.com/contacts/${contactId}/tags`;
  console.log(`[Leadhub] → POST ${tagUrl}  tags=${JSON.stringify(tags)}`);

  await axios.post(
    tagUrl,
    { tags },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  );

  console.log(`[Leadhub] ✓ contact tags applied  contact=${contactId}  tags=${tags.join(", ")}`);
}

// ─── Main entry point called by webhookProcessor executeAction ────────────────

export async function processLeadhubCreateAndContact(
  userId: string | null,
  input: LeadhubActionInput
): Promise<LeadhubActionResult> {
  console.log("[Leadhub] processLeadhubCreateAndContact START");
  console.log("[Leadhub] input:", JSON.stringify(input, null, 2));

  // ── Resolve locationId ─────────────────────────────────────────────────────
  const resolvedLocationId: string | undefined =
    input.locationId ?? (userId ? await getLocationIdByUserId(userId) : undefined);

  if (!resolvedLocationId) {
    throw new Error(
      "[Leadhub] locationId not found. Set config.locationId on the workflow node or ensure the workflow has a valid user_id."
    );
  }

  const locationId: string = resolvedLocationId;
  console.log("[Leadhub] locationId:", locationId);

  // ── Step 1: Strip opportunity-only fields; pass remaining to createContact ─
  // GHL contacts API rejects: stageId, pipelineId, markAsLead, first_name, last_name
  // Also normalise snake_case name fields → camelCase (GHL expects firstName/lastName)
  const flatInput = { ...input, ...(input.contact ?? {}) };

  const {
    stageId,
    pipelineId,
    pipelineStageId: pipelineStageIdFromInput,
    markAsLead,
    opportunityName,
    opportunityStatus,
    monetaryValue,
    opportunityValue,
    quoteValue,
    value,
    tags,
    locationId: _loc,
    first_name,
    last_name,
    contact: _contactNested,
    ...rest
  } = flatInput;

  const contactFields: Record<string, any> = {
    ...rest,
    ...(first_name || rest.firstName ? { firstName: first_name || rest.firstName } : {}),
    ...(last_name  || rest.lastName  ? { lastName:  last_name  || rest.lastName  } : {}),
  };

  if (contactFields.phone) {
    contactFields.phone = sanitizePhone(contactFields.phone);
  }
  if (contactFields.mobile) {
    contactFields.mobile = sanitizePhone(contactFields.mobile);
  }

  const { contactId, created: contactCreated } = await createContact(
    locationId,
    contactFields
  );

  console.log(
    `[Leadhub] Contact | id=${contactId} | created=${contactCreated}`
  );

  const tagList = parseTags(tags);

  // ── Step 2: Handle opportunity ────────────────────────────────────────────
  // stageId is the field name used in workflow static mappings; pipelineStageId is the alias
  const pipelineStageId = pipelineStageIdFromInput ?? stageId;
  const resolvedMonetaryValue = parseMoney(
    monetaryValue ?? opportunityValue ?? quoteValue ?? value
  );
  console.log("[Leadhub] pipelineStageId:", pipelineStageId, "| pipelineId:", pipelineId);

  if (!pipelineId || !pipelineStageId) {
    console.warn(
      "[Leadhub] pipelineId or pipelineStageId not provided — skipping opportunity step."
    );
    return { contactId, contactCreated, opportunityId: null, opportunityAction: "skipped" };
  }

  const accessToken = await getValidAccessToken(locationId);
  if (!accessToken) {
    throw new Error(`[Leadhub] Access token not found for location: ${locationId}`);
  }

  await addTagsToContact(accessToken, contactId, tagList);

  let opportunityId: string | null = null;
  let opportunityAction: "created" | "updated" | "skipped" = "skipped";

  try {
    // Search for an existing opportunity for this contact + pipeline
    console.log(
      `[Leadhub] → opportunity search  location=${locationId}  contact=${contactId}  pipeline=${pipelineId}`
    );

    let opportunities = await searchOpportunities(accessToken, {
      location_id: locationId,
      contact_id: contactId,
      pipeline_id: pipelineId,
      limit: 100,
    });

    let locationMatches: any[] = [];

    if (opportunities.length === 0) {
      console.log("[Leadhub] direct contact search returned 0; trying wider pipeline search...");
      const pipelineOpportunities = await searchOpportunities(accessToken, {
        location_id: locationId,
        pipeline_id: pipelineId,
        limit: 100,
      });
      opportunities = pipelineOpportunities.filter((opportunity) =>
        opportunityMatchesContact(opportunity, contactId, contactFields)
      );
    }

    if (opportunities.length === 0) {
      console.log("[Leadhub] pipeline search returned 0; trying location-wide contact match...");
      const locationOpportunities = await searchOpportunities(accessToken, {
        location_id: locationId,
        limit: 100,
      });
      locationMatches = locationOpportunities.filter((opportunity) =>
        opportunityMatchesContact(opportunity, contactId, contactFields)
      );
      opportunities = locationMatches.filter((opportunity) => pipelineIdOf(opportunity) === String(pipelineId));

      if (opportunities.length === 0 && locationMatches.length > 0) {
        console.log(
          `[Leadhub] found ${locationMatches.length} matching opportunit${locationMatches.length === 1 ? "y" : "ies"} in other pipeline(s); moving first match instead of creating duplicate`
        );
        opportunities = locationMatches;
      }
    }

    console.log(`[Leadhub] ← opportunity search returned ${opportunities.length} matching result(s)`);

    if (opportunities.length > 0) {
      // ── Update existing opportunity ────────────────────────────────────────
      opportunityId = opportunities[0].id;
      const updateUrl = `https://services.leadconnectorhq.com/opportunities/${opportunityId}`;

      const updatePayload: Record<string, any> = { pipelineId, pipelineStageId };
      if (opportunityStatus) updatePayload.status = opportunityStatus;
      updatePayload.name = resolveOpportunityName(opportunityName, contactFields, opportunityId ?? contactId);
      if (resolvedMonetaryValue !== undefined) updatePayload.monetaryValue = resolvedMonetaryValue;

      console.log(
        `[Leadhub] → PUT ${updateUrl}  payload=${JSON.stringify(updatePayload)}`
      );

      await axios.put(updateUrl, updatePayload, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });

      opportunityAction = "updated";
      console.log(`[Leadhub] ✓ opportunity updated  id=${opportunityId}`);
    } else {
      // ── Create new opportunity ─────────────────────────────────────────────
      console.log("[Leadhub] no existing opportunity — creating...");

      const resolvedOpportunityName = resolveOpportunityName(
        opportunityName,
        contactFields,
        contactFields.email || contactFields.phone || contactId
      );

      const createOppPayload: Record<string, any> = {
        locationId,
        pipelineId,
        pipelineStageId,
        contactId,
        name: resolvedOpportunityName,
        status: opportunityStatus ?? "open",
      };
      if (resolvedMonetaryValue !== undefined) {
        createOppPayload.monetaryValue = resolvedMonetaryValue;
      }
      if (contactFields.source) createOppPayload.source = contactFields.source;

      const createUrl = "https://services.leadconnectorhq.com/opportunities/";
      console.log(
        `[Leadhub] → POST ${createUrl}  payload=${JSON.stringify(createOppPayload)}`
      );

      const createOppResponse = await axios.post(createUrl, createOppPayload, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });

      opportunityId = createOppResponse.data.opportunity?.id ?? null;
      opportunityAction = "created";
      console.log(
        `[Leadhub] ✓ opportunity created  id=${opportunityId}  name="${resolvedOpportunityName}"`
      );
    }
  } catch (err: any) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    const method = err?.config?.method?.toUpperCase();
    const url = err?.config?.url;
    console.error(
      `[Leadhub] ✖ opportunity step failed  ${method ?? "?"} ${url ?? "?"}  status=${status}  body=${JSON.stringify(body)?.slice(0, 500)}  message=${err?.message}`
    );
    // opportunityAction remains "skipped" — this is a soft-fail by design so
    // that a LeadHub outage does not break the upstream contact creation.
    // The caller sees opportunityAction="skipped" in the action result.
  }

  console.log("[Leadhub] processLeadhubCreateAndContact DONE");
  return { contactId, contactCreated, opportunityId, opportunityAction, tagsApplied: tagList };
}
