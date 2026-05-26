import axios from "axios";
import { getValidAccessToken } from "../../../../common/function.js";

export async function getTagsService(locationId: string){
console.log("the location id weil ner ",locationId);
    // get valid access token (refreshes if expired)
    const accessToken = await getValidAccessToken(locationId);
console.log("Access token retrieved:", accessToken.substring(0, 20) + "...");

    const response = await axios.get(
  `https://services.leadconnectorhq.com/locations/${locationId}/tags`,
  {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  }
);

    const tags = response.data;

    if(!tags || tags === 0){
        console.log("No tags found for location:", locationId);
        return;
    }
    return tags;
}






