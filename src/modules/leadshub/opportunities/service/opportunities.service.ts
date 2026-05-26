import axios from "axios";
import { supabase } from "../../../../config/db.config.js";
import { getValidAccessToken } from "../../../../common/function.js";
import { UpdateOpportunityDTO } from "../dto/update-opportunities.dto.js";

export async function syncOpportunity(opportunityId: string) {

  console.log("=====================================");
  console.log("🚀 syncOpportunity START");
  console.log("📍 OpportunityId:", opportunityId);
  console.log("=====================================");

  // 1️⃣ Get Opportunity from DB
  const { data: opportunityData, error: opportunityError } = await supabase
    .from("leadshub_opportunities")
    .select("location_id")
    .eq("id", opportunityId)
    .single();

  if (opportunityError || !opportunityData) {
    console.error("❌ Opportunity not found:", opportunityError);
    throw new Error("Opportunity not found in database");
  }

  const locationId = opportunityData.location_id;

  console.log("✅ LocationId Found:", locationId);

  // 2️⃣ Get valid access token (refreshes if expired)
  const accessToken = await getValidAccessToken(locationId);

  if (!accessToken) {
    console.error("❌ Access token not found");
    throw new Error("Access token not found for location");
  }

  console.log("✅ Access token obtained");

  try {

    // 3️⃣ Call GHL API (Single Opportunity)
    console.log("📡 Calling GHL Opportunity API...");

    const response = await axios.get(
      `https://services.leadconnectorhq.com/opportunities/${opportunityId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: "2021-07-28",
          Accept: "application/json"
        }
      }
    );

    console.log("✅ GHL API Success");

    const opportunity = response.data.opportunity;

    if (!opportunity) {
      console.log("⚠ No opportunity returned.");
      return null;
    }
    console.log("📊 Opportunity Data:", opportunity);
    return opportunity;

  } catch (error: any) {

    console.log("=====================================");
    console.error("❌ GHL API ERROR");
    console.error("Status:", error.response?.status);
    console.error("Data:", error.response?.data);
    console.error("Message:", error.message);
    console.log("=====================================");

    throw error;
  }
}





export async function syncOpportunities(locationId: string) {

  console.log("=====================================");
  console.log("🚀 syncOpportunities START");
  console.log("📍 LocationId:", locationId);
  console.log("=====================================");

  // 1️⃣ Get valid access token (refreshes if expired)
  const accessToken = await getValidAccessToken(locationId);

  if (!accessToken) {
    console.error("❌ Access token not found");
    throw new Error("Access token not found for location");
  }

  console.log("✅ Access token obtained");
  console.log("🔐 Token LocationId:", locationId);

  try {

    // 2️⃣ Call GHL Opportunities Search API
    console.log("📡 Calling GHL Opportunities Search API...");

    const response = await axios.get(
      "https://services.leadconnectorhq.com/opportunities/search",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: "2021-07-28",
          Accept: "application/json"
        },
        params: {
          location_id: locationId
        }
      }
    );

    console.log("✅ API Response Received");
    console.log("📦 Raw Keys:", Object.keys(response.data));

    const opportunities = response.data.opportunities || [];

    console.log("📊 Total Opportunities:", opportunities.length);
        console.log("📊 Total Opportunities:", opportunities);


    if (!opportunities.length) {
      console.log("⚠ No opportunities found for this location.");
      return [];
    }
    const formattedOpportunities = opportunities.map((op: any) => ({
        id: op.id,
        location_id: op.locationId,
        contact_id: op.contactId,

        name: op.name,
        monetary_value: op.monetaryValue || 0,

        pipeline_id: op.pipelineId,
        pipeline_stage_id: op.pipelineStageId,

        assigned_to: op.assignedTo,
        status: op.status,
        source: op.source,

        lost_reason_id: op.lostReasonId,

        last_status_change_at: op.lastStatusChangeAt,
        last_stage_change_at: op.lastStageChangeAt,

        created_at: op.createdAt,
        updated_at: op.updatedAt,

        // Embedded Contact Info (Denormalized for fast query)
        contact_name: op.contact?.name,
        contact_email: op.contact?.email,
        contact_phone: op.contact?.phone,
        contact_company_name: op.contact?.companyName,

        contact_tags: op.contact?.tags || [],

        // Raw JSON Fields (optional but useful)
        custom_fields: op.customFields || [],
        followers: op.followers || []
        }));

     console.log("🛠 Formatted Opportunities:", formattedOpportunities.length);

    // 4️⃣ Upsert into Supabase
    const { error: insertError } = await supabase
      .from("leadshub_opportunities")
      .upsert(formattedOpportunities);

    if (insertError) {
      console.error("❌ Supabase Insert Error:", insertError);
      throw new Error(insertError.message);
    }

     console.log("✅ Data Inserted Successfully");

    // return formattedOpportunities;

  } catch (error: any) {

    console.log("=====================================");
    console.error("❌ API ERROR");
    console.error("Status:", error.response?.status);
    console.error("Response Data:", error.response?.data);
    console.error("Message:", error.message);
    console.log("=====================================");

    throw error;
  }
}


// update in both leadshub and local db
export async function updateOpportunity(
  opportunityId: string,
  updateDTO: UpdateOpportunityDTO
) {

  console.log("=====================================");
  console.log("🚀 UpdateOpportunity START");
  console.log("📍 OpportunityId:", opportunityId);
  console.log("=====================================");

  // 1️⃣ Get Opportunity from Local DB
  const { data: opportunityData, error: opportunityError } = await supabase
    .from("leadshub_opportunities")
    .select("location_id")
    .eq("id", opportunityId)
    .single();

  if (opportunityError || !opportunityData) {
    console.error("❌ Opportunity not found:", opportunityError);
    throw new Error("Opportunity not found in database");
  }

  const locationId = opportunityData.location_id;
  console.log("✅ LocationId Found:", locationId);

  // 2️⃣ Get valid access token (refreshes if expired)
  const accessToken = await getValidAccessToken(locationId);

  if (!accessToken) {
    console.error("❌ Access token not found");
    throw new Error("Access token not found for location");
  }

  try {

    // 3️⃣ Update in GHL First
    console.log("📡 Updating in GHL...");

    const ghlResponse = await axios.put(
      `https://services.leadconnectorhq.com/opportunities/${opportunityId}`,
      updateDTO,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: "2021-07-28",
          Accept: "application/json"
        }
      }
    );

    console.log("✅ GHL Updated Successfully");

    const updatedOpportunity = ghlResponse.data.opportunity;

    // 4️⃣ Map GHL Response → Local DB Format
    const localUpdate = {
      name: updatedOpportunity.name,
      monetary_value: updatedOpportunity.monetaryValue,
      pipeline_id: updatedOpportunity.pipelineId,
      pipeline_stage_id: updatedOpportunity.pipelineStageId,
      assigned_to: updatedOpportunity.assignedTo,
      status: updatedOpportunity.status,
      source: updatedOpportunity.source,
      lost_reason_id: updatedOpportunity.lostReasonId,
      last_status_change_at: updatedOpportunity.lastStatusChangeAt,
      last_stage_change_at: updatedOpportunity.lastStageChangeAt,
      updated_at: updatedOpportunity.updatedAt
    };

    // 5️⃣ Update Local Database
    const { error: localUpdateError } = await supabase
      .from("leadshub_opportunities")
      .update(localUpdate)
      .eq("id", opportunityId);

    if (localUpdateError) {
      console.error("❌ Local DB Update Error:", localUpdateError);
      throw new Error(localUpdateError.message);
    }

    console.log("✅ Local Database Updated Successfully");
    console.log("=====================================");
    console.log("🎉 UpdateOpportunity END");
    console.log("=====================================");

    return updatedOpportunity;

  } catch (error: any) {

    console.log("=====================================");
    console.error("❌ UPDATE ERROR");
    console.error("Status:", error.response?.status);
    console.error("Data:", error.response?.data);
    console.error("Message:", error.message);
    console.log("=====================================");

    throw error;
  }
}
