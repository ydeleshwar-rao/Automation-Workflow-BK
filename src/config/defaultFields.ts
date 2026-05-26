// services/ghl/defaultFields.ts

export const CONTACT_ACTION_FIELDS = [
  {
    name: "stageId",
    label: "Select Stage",
    required: true,
    type: "select",
    placeholder: "Choose value...",
    optionsSource: "pipelineStages",
  },
  {
    name: "pipelineId",
    label: "Pipeline",
    required: true,
    type: "select",
    placeholder: "Select pipeline...",
    optionsSource: "pipelines",
  },
  {
    name: "tags",
    label: "Tags (Comma delimited string for multiple tags)",
    required: false,
    type: "text",
    placeholder: "Enter tags...",
  },
  {
    name: "markAsLead",
    label: "Mark as Lead",
    required: true,
    type: "radio",
    options: [
      { label: "True", value: true },
      { label: "False", value: false },
    ],
  },
  {
    name: "opportunityName",
    label: "Opportunity Name",
    required: false,
    type: "text",
    placeholder: "Enter or map opportunity name...",
  },
  {
    name: "monetaryValue",
    label: "Opportunity Value",
    required: false,
    type: "text",
    placeholder: "Enter or map quote/proposal value...",
  },
];

export const DEFAULT_FIELDS = {
  contact: [
    { key: "contact.first_name", name: "First Name", dataType: "TEXT", standard: true, model: "contact" },
    { key: "contact.last_name", name: "Last Name", dataType: "TEXT", standard: true, model: "contact" },
    { key: "contact.email", name: "Email", dataType: "EMAIL", standard: true, model: "contact" },
    { key: "contact.phone", name: "Phone", dataType: "PHONE", standard: true, model: "contact" },
    { key: "contact.address1", name: "Address", dataType: "TEXT", standard: true, model: "contact" },
    { key: "contact.city", name: "City", dataType: "TEXT", standard: true, model: "contact" },
    { key: "contact.state", name: "State", dataType: "TEXT", standard: true, model: "contact" },
    { key: "contact.postalCode", name: "Postal Code", dataType: "TEXT", standard: true, model: "contact" },
    { key: "contact.country", name: "Country", dataType: "TEXT", standard: true, model: "contact" },
    { key: "contact.companyName", name: "Company Name", dataType: "TEXT", standard: true, model: "contact" },
    { key: "contact.website", name: "Website", dataType: "TEXT", standard: true, model: "contact" },
    { key: "contact.source", name: "Source", dataType: "TEXT", standard: true, model: "contact" },
    { key: "contact.type", name: "Contact Type", dataType: "TEXT", standard: true, model: "contact" },
    { key: "contact.dnd", name: "DND", dataType: "BOOLEAN", standard: true, model: "contact" },
    { key: "contact.timezone", name: "Timezone", dataType: "TEXT", standard: true, model: "contact" },
    { key: "contact.dateOfBirth", name: "Date of Birth", dataType: "DATE", standard: true, model: "contact" },
  ],

  opportunity: [
    { key: "opportunity.name", name: "Opportunity Name", dataType: "TEXT", standard: true, model: "opportunity" },
    { key: "opportunity.status", name: "Status", dataType: "TEXT", standard: true, model: "opportunity" },
    { key: "opportunity.monetaryValue", name: "Value", dataType: "NUMBER", standard: true, model: "opportunity" },
    { key: "opportunity.pipeline", name: "Pipeline", dataType: "TEXT", standard: true, model: "opportunity" },
    { key: "opportunity.pipelineStage", name: "Pipeline Stage", dataType: "TEXT", standard: true, model: "opportunity" },
    { key: "opportunity.closeDate", name: "Close Date", dataType: "DATE", standard: true, model: "opportunity" },
    { key: "opportunity.source", name: "Source", dataType: "TEXT", standard: true, model: "opportunity" },
    { key: "opportunity.assignedTo", name: "Assigned To", dataType: "TEXT", standard: true, model: "opportunity" },
  ],

  business: [
    { key: "business.name", name: "Company Name", dataType: "TEXT", standard: true, model: "business" },
    { key: "business.phone", name: "Phone", dataType: "PHONE", standard: true, model: "business" },
    { key: "business.email", name: "Email", dataType: "EMAIL", standard: true, model: "business" },
    { key: "business.website", name: "Website", dataType: "TEXT", standard: true, model: "business" },
    { key: "business.address", name: "Address", dataType: "TEXT", standard: true, model: "business" },
    { key: "business.city", name: "City", dataType: "TEXT", standard: true, model: "business" },
    { key: "business.state", name: "State", dataType: "TEXT", standard: true, model: "business" },
    { key: "business.postalCode", name: "Postal Code", dataType: "TEXT", standard: true, model: "business" },
    { key: "business.country", name: "Country", dataType: "TEXT", standard: true, model: "business" },
    { key: "business.description", name: "Description", dataType: "LARGE_TEXT", standard: true, model: "business" },
  ],
};
