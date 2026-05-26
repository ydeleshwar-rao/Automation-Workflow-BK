/**
 * Verifies Commusoft job sync: API job counts with/without status filter vs DB state.
 *
 * Usage:
 *   npx tsx scripts/verify-commusoft-jobs-sync.ts
 *   COMMUSOFT_VERIFY_USER_ID=<uuid> npx tsx scripts/verify-commusoft-jobs-sync.ts
 */
import "../src/config/env.config.js";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { extractCommusoftArray } from "../src/utils/commusoft-helpers.js";
import { CommusoftService, getParams } from "../src/modules/initgrations/commusoft/service/commusoft.service.js";

const COMMUSOFT_API_BASE =
  "https://app.commusoft.co.uk/webservice_dev.php/api/v1";

const ALL_STATUSES = [
  "ongoing",
  "reserved",
  "on_hold",
  "waiting_for_customer",
  "completed",
] as const;

function countByCompleteFlag(jobs: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of jobs) {
    const r = row as Record<string, unknown>;
    const key = String(r["Is Job Complete"] ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function fetchJobCount(
  userId: string,
  extraParams: Record<string, string | number>
): Promise<number> {
  const authParams = await getParams(userId);
  const response = await axios.get(`${COMMUSOFT_API_BASE}/jobs`, {
    params: { ...authParams, ...extraParams },
  });
  return extractCommusoftArray(response.data, ["Jobs", "jobs", "Job"]).length;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(url, key);
  let userId = process.env.COMMUSOFT_VERIFY_USER_ID;

  if (!userId) {
    const { data: integrations, error } = await supabase
      .from("commusoft_intigrations")
      .select("user_id")
      .limit(5);

    if (error || !integrations?.length) {
      console.error("No commusoft_intigrations rows found:", error?.message);
      process.exit(1);
    }
    userId = integrations[0].user_id as string;
    console.log(`Using first Commusoft user: ${userId}`);
  } else {
    console.log(`Using COMMUSOFT_VERIFY_USER_ID: ${userId}`);
  }

  console.log("\n--- Live API job counts (same user) ---");
  const tokenOnly = await fetchJobCount(userId, {});
  let perStatusTotal = 0;
  const perStatus: Record<string, number> = {};
  for (const status of ALL_STATUSES) {
    const n = await fetchJobCount(userId, {
      status,
      "number of records": 500,
      "starting record": 1,
    });
    perStatus[status] = n;
    perStatusTotal += n;
  }

  console.log(`  token only (no status param):     ${tokenOnly}`);
  console.log("  per-status (batch size 500):");
  for (const [status, n] of Object.entries(perStatus)) {
    console.log(`    ${status}: ${n}`);
  }
  console.log(`  sum of per-status (may overlap):  ${perStatusTotal}`);

  if (perStatusTotal > tokenOnly) {
    console.log("  ✓ Per-status fetch returns more rows than default (token-only)");
  }

  console.log("\n--- DB state (commusoft_jobs) ---");
  const { count: totalForUser, error: countErr } = await supabase
    .from("commusoft_jobs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  if (countErr) {
    console.error("  count error:", countErr.message);
  } else {
    console.log(`  rows for user_id: ${totalForUser ?? 0}`);
  }

  const { data: sampleRows, error: sampleErr } = await supabase
    .from("commusoft_jobs")
    .select('"Is Job Complete", "Customer Name", jobId')
    .eq("user_id", userId)
    .limit(5000);

  if (sampleErr) {
    console.error("  sample error:", sampleErr.message);
  } else {
    const completeCounts = countByCompleteFlag(sampleRows ?? []);
    console.log("  by Is Job Complete / Job Status:", completeCounts);

    const names = ["wbt test83", "tost", "Mr tost 2"];
    for (const name of names) {
      const n = (sampleRows ?? []).filter(
        (r) =>
          String((r as Record<string, unknown>)["Customer Name"] ?? "")
            .toLowerCase()
            .includes(name.toLowerCase())
      ).length;
      console.log(`  jobs matching "${name}": ${n}`);
    }
  }

  const { count: customersCount } = await supabase
    .from("customers")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  console.log(`\n  customers table rows: ${customersCount ?? "(table missing?)"}`);

  const runSync = process.env.COMMUSOFT_VERIFY_RUN_SYNC === "1";
  if (runSync) {
    console.log("\n--- Running CommusoftService.getJobs (sync) ---");
    const before = totalForUser ?? 0;
    await CommusoftService.getJobs(userId);
    const { count: after } = await supabase
      .from("commusoft_jobs")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);
    console.log(`  DB rows before: ${before}  after: ${after ?? "?"}`);
  } else {
    console.log(
      "\n(Set COMMUSOFT_VERIFY_RUN_SYNC=1 to run getJobs and refresh DB)"
    );
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
