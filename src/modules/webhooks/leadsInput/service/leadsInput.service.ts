
import { supabase } from "../../../../config/db.config.js";
import { CreateLeadInputDTO } from "../dto/createLeadInput.dto.js";

export async function createLeadInput(
  locationId: string,
  dto: CreateLeadInputDTO
) {
  console.log("createLeadInput service called");

  // 1️⃣ Get GHL Token (future use ke liye)
  const { data: tokenData, error: tokenError } = await supabase
    .from("ghl_tokens")
    .select("access_token")
    .eq("location_id", locationId)
    .single();

  if (tokenError || !tokenData) {
    throw new Error(`Token not found for location: ${locationId}`);
  }
console.log("data_recived",dto);
  // 2️⃣ Store Raw Webhook Data
  const { data, error } = await supabase
    .from("lead_input_webhooks")
    .insert([
      {
        client_id: locationId,
        source: dto.source || "unknown",
        payload: dto.payload,
        headers: dto.headers || {},
      },
    ])
    .select()
    .single();

  if (error) {
    console.error("DB Error:", error);
    throw new Error("Failed to store webhook data");
  }

  return data;
}


export async function getLeadInputService(locationId: string){

// auth from db 
// const {data: tokenData, error: tokenError} = await supabase
//   .from("ghl_tokens")
//   .select("access_token")
//   .eq("location_id", locationId)
//   .single();

//     if (tokenError || !tokenData) {
//     throw new Error(`Token not found for location: ${locationId}`);
//   }

  // get data  from supabase 

  const {data: leadData, error: leadError} = await supabase
  .from("lead_input_webhooks")
  .select("payload")
  .eq("client_id", locationId)
  .single();

    if (leadError || !leadData) {
    throw new Error(`lead data not found for location: ${locationId}`);
  }


  console.log("datalead",leadData);
  
return leadData;

}