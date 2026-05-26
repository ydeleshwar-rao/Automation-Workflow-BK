import { getBigQueryClient } from "../../../lib/bigquery-server.js";


export type BigQueryClientRow = {
  client_name: string | null;
  // status: string | null;
  // start_date: string | null;
  // ghl_location_id: string | null;
  // google_ads_1: string | null;
  // google_ads_2: string | null;
  // google_ads_3: string | null;
  // meta_ads_1: string | null;
  // meta_ads_2: string | null;
  // meta_ads_3: string | null;
  // ga4_id: string | null;
  // account_manager: string | null;
  clientkey: string | null;
  // lid: string | null;
  // LocationName: string | null;
  // timezone: string | null;
  // fqdn: string | null;
  // website: string | null;
  display_name: string | null;
};

export class BigQueryClientsService {
  static async getClients(): Promise<{
    source: string;
    count: number;
    rows: BigQueryClientRow[];
  }> {
    const client = getBigQueryClient();
    const projectId = process.env.BIGQUERY_PROJECT_ID!;
    const dataset = "dataform";
    const table = "clients";

    const query = `
      SELECT
        client_name,
        clientkey,
        display_name
      FROM \`${projectId}.${dataset}.${table}\`
    `;

    const [rows] = await client.query({ query });

    return {
      source: `${projectId}.${dataset}.${table}`,
      count: rows.length,
      rows: rows as BigQueryClientRow[],
    };
  }
}