import axios from "axios";
import { getValidAccessToken } from "../../../../common/function.js";

export async function getCustomFieldService(locationId: string){
console.log("ht location id weil ner ",locationId);
    // get valid access token (refreshes if expired)
    const accessToken = await getValidAccessToken(locationId);
console.log("Access token retrieved:", accessToken.substring(0, 20) + "...");

    const response = await axios.get(
  `https://services.leadconnectorhq.com/locations/${locationId}/customFields`,
  {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  }
);

    const customFields = response.data;

    if(!customFields || customFields === 0){
        console.log("No contacts found for location:", locationId);
        return;
    }
    return customFields;
}






