import { BigQuery } from "@google-cloud/bigquery";

let cachedClient: BigQuery | null = null;

export function getBigQueryClient(): BigQuery {
  const projectId = process.env.BIGQUERY_PROJECT_ID;
  if (!projectId) {
    throw new Error("BIGQUERY_PROJECT_ID is required");
  }

  if (cachedClient) return cachedClient;

  // 1. RAW JSON (preferred for local/dev to avoid base64 issues)
  const jsonString = process.env.BIGQUERY_SERVICE_ACCOUNT_JSON;
  if (jsonString) {
    try {
      const json = JSON.parse(jsonString);
      cachedClient = new BigQuery({ projectId, credentials: json });
      return cachedClient;
    } catch (err) {
      throw new Error(
        "Failed to parse BIGQUERY_SERVICE_ACCOUNT_JSON. Ensure it is valid JSON."
      );
    }
  }

  // 2. BASE64 service account (fallback)
  const base64 = process.env.BIGQUERY_SERVICE_ACCOUNT_BASE64;
  if (base64) {
    try {
      const decoded = Buffer.from(base64, "base64").toString("utf8");
      const json = JSON.parse(decoded);
      cachedClient = new BigQuery({ projectId, credentials: json });
      return cachedClient;
    } catch (err) {
      throw new Error(
        "Failed to parse BIGQUERY_SERVICE_ACCOUNT_BASE64. Ensure it is a base64-encoded JSON service account."
      );
    }
  }

  // 3. ADC (GOOGLE_APPLICATION_CREDENTIALS, etc.)
  cachedClient = new BigQuery({ projectId });
  return cachedClient;
}