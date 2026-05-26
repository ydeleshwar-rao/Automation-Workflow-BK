import { supabase } from "../config/db.config.js";
import { refreshAccessToken } from "../modules/initgrations/serviceM8/utils/refreshAccessToken.js";

const getValidToken = async (userId: string, accessToken: string, refreshToken: string | null): Promise<string | null> => {
  // Try current access token first
  const testRes = await fetch("https://api.servicem8.com/api_1.0/CompanyConfig.json", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (testRes.ok) return accessToken;

  // Token expired — try refresh
  if (!refreshToken) {
    console.warn(`[Backfill] user=${userId} — no refresh_token, cannot renew`);
    return null;
  }

  try {
    console.log(`[Backfill] user=${userId} — access token expired, refreshing...`);
    const refreshed = await refreshAccessToken(userId, refreshToken);
    return refreshed.access_token ?? null;
  } catch (e: any) {
    console.warn(`[Backfill] user=${userId} — refresh failed: ${e?.message}`);
    return null;
  }
};

export const backfillSm8AccountUuids = async () => {
  const { data: rows, error } = await supabase
    .from("servicem8_integrations")
    .select("user_id, access_token, refresh_token")
    .is("sm8_account_uuid", null)
    .not("access_token", "is", null);

  if (error) {
    console.error("[Backfill] DB query failed:", error.message);
    return;
  }

  if (!rows || rows.length === 0) {
    console.log("[Backfill] sm8_account_uuid already populated for all users — nothing to do.");
    return;
  }

  console.log(`[Backfill] Populating sm8_account_uuid for ${rows.length} user(s)...`);
  let updated = 0;
  let failed  = 0;

  for (const row of rows) {
    try {
      const validToken = await getValidToken(row.user_id, row.access_token, row.refresh_token);
      if (!validToken) { failed++; continue; }

      const configRes = await fetch("https://api.servicem8.com/api_1.0/CompanyConfig.json", {
        headers: { Authorization: `Bearer ${validToken}`, Accept: "application/json" },
      });

      if (!configRes.ok) {
        const body = await configRes.text().catch(() => "(unreadable)");
        console.warn(`[Backfill] user=${row.user_id} CompanyConfig HTTP ${configRes.status} — body: ${body.slice(0, 300)}`);

        // Fallback: try /company.json — first record is the main company
        console.log(`[Backfill] user=${row.user_id} trying fallback /company.json...`);
        const fallbackRes = await fetch("https://api.servicem8.com/api_1.0/company.json", {
          headers: { Authorization: `Bearer ${validToken}`, Accept: "application/json" },
        });
        if (!fallbackRes.ok) {
          const fb = await fallbackRes.text().catch(() => "(unreadable)");
          console.warn(`[Backfill] user=${row.user_id} /company.json HTTP ${fallbackRes.status} — body: ${fb.slice(0, 200)}`);
          failed++;
          continue;
        }
        const fallbackData = await fallbackRes.json();
        const firstCompany = Array.isArray(fallbackData) ? fallbackData[0] : fallbackData;
        const uuid = firstCompany?.uuid ?? null;
        if (!uuid) {
          console.warn(`[Backfill] user=${row.user_id} — no uuid in /company.json either`);
          failed++;
          continue;
        }
        console.log(`[Backfill] user=${row.user_id} → sm8_account_uuid=${uuid} (via /company.json)`);
        await supabase.from("servicem8_integrations").update({ sm8_account_uuid: uuid }).eq("user_id", row.user_id);
        updated++;
        continue;
      }

      const configData = await configRes.json();
      console.log(`[Backfill] user=${row.user_id} CompanyConfig raw:`, JSON.stringify(configData).slice(0, 200));
      const record = Array.isArray(configData) ? configData[0] : configData;
      const uuid = record?.uuid ?? null;

      if (!uuid) {
        console.warn(`[Backfill] user=${row.user_id} — no uuid in CompanyConfig response:`, JSON.stringify(configData).slice(0, 200));
        failed++;
        continue;
      }

      const { error: updateError } = await supabase
        .from("servicem8_integrations")
        .update({ sm8_account_uuid: uuid })
        .eq("user_id", row.user_id);

      if (updateError) {
        console.error(`[Backfill] user=${row.user_id} DB update failed:`, updateError.message);
        failed++;
      } else {
        console.log(`[Backfill] user=${row.user_id} → sm8_account_uuid=${uuid}`);
        updated++;
      }
    } catch (e: any) {
      console.error(`[Backfill] user=${row.user_id} error:`, e?.message);
      failed++;
    }
  }

  console.log(`[Backfill] Done — updated=${updated}  failed=${failed}  total=${rows.length}`);
};
