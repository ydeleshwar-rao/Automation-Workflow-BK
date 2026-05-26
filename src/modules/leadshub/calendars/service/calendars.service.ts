import axios from "axios";
import { getValidAccessToken } from "../../../../common/function.js";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";

export async function getCalendarsService(locationId: string) {
  const accessToken = await getValidAccessToken(locationId);
  if (!accessToken) {
    throw new Error("Access token not found for location");
  }

  const response = await axios.get(`${GHL_BASE_URL}/calendars/`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
    params: {
      locationId,
    },
  });

  return Array.isArray(response.data?.calendars) ? response.data.calendars : [];
}
