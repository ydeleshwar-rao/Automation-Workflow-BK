import axios from "axios";
import { getValidAccessToken } from "../../../../../common/function.js";
import { supabase } from "../../../../../config/db.config.js";

export async function syncPipeLines(locationId: string) {
  console.log("Pipeline sync started for locationId:", locationId);

  // ✅ 1. Get valid access token (refreshes if expired)
  const accessToken = await getValidAccessToken(locationId);

  if (!accessToken) {
    console.log("Access token not available");
    throw new Error("Access token not found for location");
  }



  try {
    // ✅ 2. Call GHL API
    console.log("Calling GHL Pipelines API...");

 const response = await axios.get(
  "https://services.leadconnectorhq.com/opportunities/pipelines",
  {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: "2021-07-28",
      Accept: "application/json"
    },
    params: {
      locationId: locationId // ✅ correct
    }
  }
);


    console.log("GHL API Success");

    const pipelines = response.data.pipelines;

    if (!pipelines || pipelines.length === 0) {
      console.log("No pipelines found");
      return;
    }

    console.log("Pipelines received:", pipelines.length);

    // ================================
    // ✅ 3. UPSERT PIPELINES (with stages as JSONB)
    // ================================

    const pipelinePayload = pipelines.map((pipeline: any) => ({
      id: pipeline.id,
      location_id: locationId,
      name: pipeline.name,
      origin_id: pipeline.originId ?? null,
      use_opportunity_probability: pipeline.useOpportunityProbability ?? false,
      stages: pipeline.stages ?? [],
      updated_at: new Date(),
    }));

    const { error: pipelineUpsertError } = await supabase
      .from("leadshub_pipelines")
      .upsert(pipelinePayload, { onConflict: "id" });

    if (pipelineUpsertError) {
      console.error("Pipeline Upsert Error:", pipelineUpsertError);
      throw pipelineUpsertError;
    }

    console.log("Pipelines synced successfully");
    console.log("Pipeline Sync Completed Successfully");
        return "Pipeline Sync Completed Successfully";
  } catch (err: any) {
    console.error("Pipeline Sync Failed:", err.response?.data || err.message);
    throw err;
  }
}

export async function getPipelinesService(locationId: string) {
  await syncPipeLines(locationId);

  const { data, error } = await supabase
    .from("leadshub_pipelines")
    .select("*")
    .eq("location_id", locationId);

  if (error) {
    throw error;
  }

  return data;
}