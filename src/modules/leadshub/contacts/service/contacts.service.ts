import axios from "axios";
import { supabase } from "../../../../config/db.config.js";
import { getValidAccessToken } from "../../../../common/function.js";

function normalizePhoneForCompare(raw: unknown): string {
  return String(raw ?? "").replace(/[^\d+]/g, "");
}

function extractContactIdFromDuplicateBody(body: any): string | null {
  return (
    body?.contact?.id ??
    body?.contactId ??
    body?.id ??
    body?.meta?.contactId ??
    body?.meta?.contact_id ??
    null
  );
}

function isDuplicateContactError(err: any): boolean {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const text = [
    body?.message,
    body?.error,
    body?.msg,
    err?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return status === 409 || text.includes("duplicated contact") || text.includes("duplicate contact");
}

async function findExistingContactId(
  accessToken: string,
  locationId: string,
  cleanedData: Record<string, any>
): Promise<string | null> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Version: "2021-07-28",
    Accept: "application/json",
  };

  const duplicateAttempts = [
    cleanedData.email ? { email: cleanedData.email } : null,
    cleanedData.phone ? { phone: cleanedData.phone } : null,
  ].filter(Boolean) as Array<Record<string, string>>;

  for (const attempt of duplicateAttempts) {
    try {
      const response = await axios.get(
        "https://services.leadconnectorhq.com/contacts/search/duplicate",
        {
          headers,
          params: { locationId, ...attempt },
        }
      );

      const id = response.data?.contact?.id ?? response.data?.id ?? null;
      if (id) return id;
    } catch (err: any) {
      if (err.response?.status !== 404) {
        console.warn(
          "Contact duplicate lookup failed:",
          err.response?.data ?? err.message
        );
      }
    }
  }

  const listQueries = [cleanedData.email, cleanedData.phone].filter(Boolean);
  for (const query of listQueries) {
    try {
      const response = await axios.get(
        "https://services.leadconnectorhq.com/contacts/",
        {
          headers,
          params: {
            locationId,
            query,
            limit: 20,
          },
        }
      );

      const contacts = response.data?.contacts ?? [];
      const targetEmail = String(cleanedData.email ?? "").toLowerCase();
      const targetPhone = normalizePhoneForCompare(cleanedData.phone);
      const match = contacts.find((contact: any) => {
        const emailMatches =
          targetEmail &&
          String(contact.email ?? "").toLowerCase() === targetEmail;
        const phoneMatches =
          targetPhone &&
          normalizePhoneForCompare(contact.phone) === targetPhone;
        return emailMatches || phoneMatches;
      });

      if (match?.id) return match.id;
    } catch (err: any) {
      console.warn(
        "Contact list lookup failed:",
        err.response?.data ?? err.message
      );
    }
  }

  return null;
}

export async function syncContacts(locationId: string) {
// Token Fetch - get valid token (refreshes if expired)
const accessToken = await getValidAccessToken(locationId);

    if (!accessToken) {
        throw new Error("Access token not found for location:");
    }

      const response = await axios.get(
        "https://services.leadconnectorhq.com/contacts/",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Version: "2021-07-28",
            Accept: "application/json"
          },
          params: {
            locationId: locationId
          }
        }
      );



    const contacts = response.data.contacts;

    if(!contacts || contacts.length === 0) {
        console.log("No contacts found for location:", locationId);
        return;
    }
    console.log("contacts :", contacts);
    // 3️⃣ Store in Supabase
const formattedContacts = contacts.map((contact: any) => ({
  ghl_contact_id: contact.id,
  location_id: contact.locationId,

  // Basic Info
  first_name: contact.firstName,
  last_name: contact.lastName,
  first_name_raw: contact.firstNameRaw,
  last_name_raw: contact.lastNameRaw,
  contact_name: contact.contactName,

  // Contact Details
  email: contact.email,
  additional_emails: contact.additionalEmails,
  phone: contact.phone,
  dnd: contact.dnd,
  dnd_settings: contact.dndSettings,

  // Address
  address1: contact.address1,
  city: contact.city,
  state: contact.state,
  postal_code: contact.postalCode,
  country: contact.country,

  // Business Info
  company_name: contact.companyName,
  business_id: contact.businessId,
  website: contact.website,
  type: contact.type,
  source: contact.source,
  assigned_to: contact.assignedTo,

  // Social / Extra
  tags: contact.tags,
  followers: contact.followers,
  profile_photo: contact.profilePhoto,
  timezone: contact.timezone,
  attributions: contact.attributions,

  // Custom Data
  custom_fields: contact.customFields,
  date_of_birth: contact.dateOfBirth,

  // Meta
  date_added: contact.dateAdded,
  date_updated: contact.dateUpdated,
  start_after: contact.startAfter,
}));

    const { error: insertError } = await supabase
        .from("leadshub_contacts")
        .upsert(formattedContacts);

    if (insertError) {
        throw new Error(insertError.message);
    }

    return formattedContacts;



} 


export async function getLocalContacts(locationId: string) {
  const { data, error } = await supabase
    .from("leadshub_contacts")
    .select("*")
    .eq("location_id", locationId);

  if (error) {
    throw new Error(error.message);
  }

  return data;
}


export async function createContact(
  locationId: string,
  rawData: any
): Promise<{ contactId: string; created: boolean }> {
  try {
    console.log("locationid", locationId);

    // ================= TOKEN =================
    const accessToken = await getValidAccessToken(locationId);

    if (!accessToken) {
      throw new Error(`Access token not found for location: ${locationId}`);
    }

    // ================= CLEAN RAW DATA =================
    // Supports two formats:
    //   1. Keys with "contact." prefix  → strips prefix + converts snake_case to camelCase
    //   2. Keys already in camelCase    → used as-is
    console.log("calling_the_service", rawData);

    const hasPrefixedKeys = Object.keys(rawData).some((k) =>
      k.startsWith("contact.")
    );

    const cleanedData: any = {};

    if (hasPrefixedKeys) {
      Object.entries(rawData).forEach(([key, value]) => {
        if (!key.startsWith("contact.")) return;
        const withoutPrefix = key.replace("contact.", "");
        const camelKey = withoutPrefix.replace(/_([a-z])/g, (_, c) =>
          c.toUpperCase()
        );
        cleanedData[camelKey] = value;
      });
    } else {
      Object.assign(cleanedData, rawData);
    }

    const contactPayload: any = { ...cleanedData, locationId };

    // convert tags string → array
    if (contactPayload.tags && typeof contactPayload.tags === "string") {
      contactPayload.tags = contactPayload.tags
        .split(",")
        .map((t: string) => t.trim());
    }

    // ================= CHECK IF CONTACT EXISTS =================
    const searchQuery: string | undefined =
      cleanedData.email ?? cleanedData.phone;

    if (!searchQuery) {
      throw new Error(
        "At least one of 'email' or 'phone' must be provided to check for an existing contact."
      );
    }

    console.log("🔍 Searching for existing contact:", searchQuery);

    let existingContactId = await findExistingContactId(
      accessToken,
      locationId,
      cleanedData
    );

    if (existingContactId) {
      console.log("✅ Contact already exists:", existingContactId);
    }

    // ================= RETURN EXISTING OR CREATE NEW =================
    if (existingContactId) {
      return { contactId: existingContactId, created: false };
    }

    console.log("📤 Contact not found — creating new contact...");
    console.log("📤 Contact payload:", JSON.stringify(contactPayload, null, 2));

    let contactResponse;
    try {
      contactResponse = await axios.post(
        "https://services.leadconnectorhq.com/contacts/",
        contactPayload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Version: "2021-07-28",
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      );
    } catch (err: any) {
      if (isDuplicateContactError(err)) {
        const bodyContactId = extractContactIdFromDuplicateBody(err.response?.data);
        const recoveredContactId =
          bodyContactId ??
          (await findExistingContactId(accessToken, locationId, cleanedData));

        if (recoveredContactId) {
          console.log("✅ Duplicate contact recovered:", recoveredContactId);
          return { contactId: recoveredContactId, created: false };
        }
      }

      throw err;
    }

    const contactId = contactResponse.data.contact.id;
    console.log("✅ Contact created:", contactId);

    return { contactId, created: true };
  } catch (error: any) {
    console.error("❌ Error:", error.response?.data || error.message);
    throw new Error(
      error.response?.data?.message ||
        error.message ||
        "Failed to create contact"
    );
  }
}
