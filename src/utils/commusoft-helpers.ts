/** Keys commonly used in Commusoft opportunity/pipeline API responses. */
export const COMMUSOFT_OPPORTUNITY_ARRAY_KEYS = [
  "details",
  "opportunities",
  "Opportunities",
  "stages",
  "Stages",
  "pipelineStages",
  "PipelineStages",
  "opportunityTemplates",
  "OpportunityTemplates",
  "templates",
] as const;

/**
 * Extract first string value from query parameter (array or single value).
 */
export function firstQueryValue(v: unknown): string | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

/**
 * Parse query parameter as integer.
 */
export function toInt(v: unknown): number | undefined {
  const raw = firstQueryValue(v);
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function valuesIfObjectArray(field: unknown): unknown[] | null {
  if (Array.isArray(field)) return field;
  if (field && typeof field === "object") {
    const values = Object.values(field as Record<string, unknown>);
    if (values.length > 0 && values[0] !== null && typeof values[0] === "object") {
      return values;
    }
  }
  return null;
}

/**
 * Generic array extractor from Commusoft API responses.
 * Handles direct arrays, nested keys, data wrappers, array-like objects, and "No Records Found".
 */
export function extractCommusoftArray(
  body: unknown,
  possibleKeys: string[] = []
): unknown[] {
  if (typeof body === "string") {
    return body.toLowerCase().includes("no record") ? [] : [];
  }

  if (Array.isArray(body)) return body;

  if (!body || typeof body !== "object") return [];

  const record = body as Record<string, unknown>;

  for (const key of possibleKeys) {
    const extracted = valuesIfObjectArray(record[key]);
    if (extracted) return extracted;
  }

  if (Array.isArray(record.data)) return record.data;

  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    for (const key of possibleKeys) {
      const extracted = valuesIfObjectArray(nested[key]);
      if (extracted) return extracted;
    }
  }

  return [];
}

/**
 * Resolve {{map:id|label|fallback}} tokens to fallback value (3rd segment).
 */
export function resolveMapTokens(value: unknown): unknown {
  const MAP_TOKEN_RE = /\{\{map:[^|]*\|[^|]*\|([^}]*)\}\}/g;

  if (typeof value === "string") {
    return value.replace(MAP_TOKEN_RE, (_, v) => v);
  }

  if (Array.isArray(value)) {
    return value.map(resolveMapTokens);
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveMapTokens(v);
    }
    return out;
  }

  return value;
}

/**
 * Remove empty/null/undefined fields from object.
 */
export function cleanEmptyFields(input: unknown): {
  cleaned: Record<string, unknown>;
  dropped: string[];
} {
  const cleaned: Record<string, unknown> = {};
  const dropped: string[] = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { cleaned, dropped };
  }

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined || value === null) {
      dropped.push(key);
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      dropped.push(key);
      continue;
    }
    cleaned[key] = value;
  }

  return { cleaned, dropped };
}
