// services/ghl/field.service.ts

import { getLocationIdByUserId } from "../../../../common/function.js";
import { DEFAULT_FIELDS, CONTACT_ACTION_FIELDS } from "../../../../config/defaultFields.js";
import { getCustomFieldService } from "./customFields.service.js";


export async function getAllFields(userId: string) {
  const locationId = await getLocationIdByUserId(userId);
  const customResponse = await getCustomFieldService(locationId);
//console.log("customer_Response",customResponse);
  //const customFields = customResponse?.data?.customFields || [];
  const customFields = customResponse?.customFields || [];

//console.log("custom_Fields",customFields);
  // group custom fields by model
  const groupedCustom: any = {
    contact: [],
    opportunity: [],
    business: [],
  };

  customFields.forEach((field: any) => {
    if (groupedCustom[field.model]) {
      groupedCustom[field.model].push({
        id: field.id,
        key: field.fieldKey,
        name: field.name,
        dataType: field.dataType,
        standard: false,
        model: field.model,
        placeholder: field.placeholder,
      });
    }
  });

  // merge default + custom
  return {
    success: true,
    message: "Default + Custom fields merged successfully",
    data: {
      contact: [...DEFAULT_FIELDS.contact, ...groupedCustom.contact],
      action: CONTACT_ACTION_FIELDS,
    },
  };
}
