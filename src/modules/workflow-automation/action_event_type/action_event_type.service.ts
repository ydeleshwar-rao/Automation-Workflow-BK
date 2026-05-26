export type ActionEventKind = "trigger" | "action";

export interface ActionType {
  action_key: string;
  label: string;
  type: ActionEventKind;
  description: string;
}

const ACTION_TYPES_LEADSHUB: ActionType[] = [
  // { action_key: "add_lead_to_workflow",       label: "Add Lead to Workflow",       type: "action" },
  // { action_key: "add_task",                   label: "Add Task",                   type: "action" },
  // { action_key: "add_update_contact",         label: "Add/Update Contact",         type: "action" },
  {
    action_key: "pipeline_stage_changed",
    label: "Pipeline Stage Changed",
    type: "trigger",
    description:
      "Fires whenever an opportunity moves into the selected pipeline stage. Use this to start a workflow when a deal is booked, qualified, won, or reaches any stage you care about.",
  },
  {
    action_key: "appointment_booked",
    label: "Appointment Booked",
    type: "trigger",
    description:
      "Fires when a LeadsHub calendar appointment is created, such as a booked survey. Use this to create the customer and survey job in the job management system.",
  },
  {
    action_key: "add_update_opportunity",
    label: "Add/Update Opportunity",
    type: "action",
    description:
      "Creates a new opportunity in LeadConnector, or updates the matching one if it already exists. Set pipeline, stage, monetary value, and contact details from workflow data.",
  },
  // { action_key: "stop_all_workflows_for_lead", label: "Stop All Workflows for Lead", type: "action" },
];

const ACTION_TYPES_SERVICE_M8: ActionType[] = [
  // Triggers (polled)
  {
    action_key: "job_completed",
    label: "Job Completed",
    type: "trigger",
    description:
      "Fires when a job is marked Completed in ServiceM8. Ideal for post-job follow-ups — send invoices, ask for reviews, or push data to accounting.",
  },
  {
    action_key: "job_queued",
    label: "Job Queued",
    type: "trigger",
    description:
      "Fires when a job is moved into a queue in ServiceM8. Optionally scope to a specific queue or category so only the right jobs start the workflow.",
  },
  {
    action_key: "new_client",
    label: "New Client",
    type: "trigger",
    description:
      "Fires when a new company (client) is created in ServiceM8. Use this to onboard clients, sync them to other systems, or send a welcome email.",
  },
  // { action_key: "new_form_response",  label: "New Form Response",  type: "trigger" },
  {
    action_key: "new_job",
    label: "New Job",
    type: "trigger",
    description:
      "Fires when a new job is created in ServiceM8. Great for kicking off scheduling, assignment, or notification workflows the moment a job lands.",
  },
  {
    action_key: "job_quote_sent",
    label: "Quote Sent",
    type: "trigger",
    description:
      "Fires when a quote is emailed to the client in ServiceM8. Use this to track quote activity, follow up automatically, or notify your team.",
  },
  {
    action_key: "job_quote_accepted",
    label: "Quote Accepted",
    type: "trigger",
    description:
      "Fires when a client accepts a quote and it converts to a Work Order in ServiceM8. The starting point for any post-acceptance automation — assign staff, move queue, send confirmation.",
  },
  // Actions (executed by workflow)
  {
    action_key: "create_client",
    label: "Create Client",
    type: "action",
    description:
      "Creates a new client (company) record in ServiceM8 using data from the workflow. Useful after capturing a lead in another system.",
  },
  {
    action_key: "create_job",
    label: "Create Job",
    type: "action",
    description:
      "Creates a new job in ServiceM8 against a client. Map job description, site address, category, and queue from earlier steps in the workflow.",
  },
  {
    action_key: "create_diary_event",
    label: "Create Diary Event",
    type: "action",
    description:
      "Schedules a diary event (booking) on the ServiceM8 Dispatch Board for a staff member against a job.",
  },
  {
    action_key: "move_job_to_queue",
    label: "Move Job to Queue",
    type: "action",
    description:
      "Moves an existing job into a specific queue in ServiceM8 — equivalent to dragging a job card onto a queue column on the dispatch board.",
  },
  {
    action_key: "update_job",
    label: "Update Job",
    type: "action",
    description:
      "Updates fields on an existing ServiceM8 job — change status (e.g. Quote → Work Order), move to a queue, update address or description. Only the fields you fill in are changed.",
  },
];

const ACTION_TYPES_COMMUSOFT: ActionType[] = [
  // Triggers (polled)
  {
    action_key: "estimate_sent",
    label: "Estimate Sent",
    type: "trigger",
    description:
      "Fires when a classic Commusoft estimate is waiting for the customer. Map this to a LeadConnector stage such as Quote Sent.",
  },
  {
    action_key: "estimate_accepted",
    label: "Estimate Accepted",
    type: "trigger",
    description:
      "Fires when a classic Commusoft estimate is accepted by the customer. Use this to move the matching LeadConnector opportunity to Quote Accepted or Won.",
  },
  {
    action_key: "estimate_rejected",
    label: "Estimate Rejected",
    type: "trigger",
    description:
      "Fires when a classic Commusoft estimate is rejected by the customer. Use this to move the matching LeadConnector opportunity to a lost or follow-up stage.",
  },
  {
    action_key: "proposal_sent",
    label: "Proposal Sent",
    type: "trigger",
    description:
      "Fires when a Commusoft opportunity appears in the configured proposal-sent stage. Map this to a LeadConnector opportunity stage such as Quote Sent.",
  },
  {
    action_key: "proposal_accepted",
    label: "Proposal Accepted",
    type: "trigger",
    description:
      "Fires when a Commusoft opportunity appears in the configured accepted/won stage. Use this to move the matching LeadConnector opportunity to Quote Accepted or Won.",
  },
  {
    action_key: "opportunity_stage_changed",
    label: "Opportunity Stage Changed",
    type: "trigger",
    description:
      "Fires when a Commusoft opportunity appears in a selected sales pipeline stage. Useful for any custom Commusoft sales stage that should sync to LeadConnector.",
  },
  {
    action_key: "job_completed",
    label: "Job Completed",
    type: "trigger",
    description:
      "Fires when a job is marked Completed in Commusoft. Use this to trigger invoicing, review requests, or any downstream post-completion flow.",
  },
  // {
  //   action_key: "job_closed",
  //   label: "Job Closed",
  //   type: "trigger",
  //   description:
  //     "Fires when a job is closed (finalised) in Commusoft. Best for end-of-lifecycle actions like archiving, reporting, or syncing to accounting.",
  // },
  {
    action_key: "new_client",
    label: "New Client",
    type: "trigger",
    description:
      "Fires when a new customer is created in Commusoft. Use to onboard them in other systems or send welcome communications.",
  },
  {
    action_key: "new_job",
    label: "New Job",
    type: "trigger",
    description:
      "Fires when a new job is created in Commusoft. Kick off scheduling, engineer assignment, or customer notifications automatically.",
  },
  // Actions (executed by workflow)
  {
    action_key: "create_client",
    label: "Create Client",
    type: "action",
    description:
      "Creates a new customer record in Commusoft using fields mapped from the workflow — useful for piping in leads from forms or other CRMs.",
  },
  {
    action_key: "create_job",
    label: "Create Job",
    type: "action",
    description:
      "Creates a new job in Commusoft linked to a customer. Map description, address, and job type from previous workflow steps.",
  },
  {
    action_key: "create_diary_event",
    label: "Create Diary Event",
    type: "action",
    description:
      "Books a Commusoft diary event, usually against a job created from a LeadsHub survey appointment.",
  },
  {
    action_key: "create_opportunity",
    label: "Create Opportunity",
    type: "action",
    description:
      "Creates a Commusoft sales opportunity for the customer using an opportunity template and booking details from the workflow.",
  },
];

export function getActionLeadshubTypes(): ActionType[] {
  return ACTION_TYPES_LEADSHUB;
}

export function getLeadshubTriggers(): ActionType[] {
  return ACTION_TYPES_LEADSHUB.filter((a) => a.type === "trigger");
}

export function getLeadshubActions(): ActionType[] {
  return ACTION_TYPES_LEADSHUB.filter((a) => a.type === "action");
}

export function getServiceM8Triggers(): ActionType[] {
  return ACTION_TYPES_SERVICE_M8.filter((a) => a.type === "trigger");
}

export function getServiceM8Actions(): ActionType[] {
  return ACTION_TYPES_SERVICE_M8.filter((a) => a.type === "action");
}

export function getCommusoftTriggers(): ActionType[] {
  return ACTION_TYPES_COMMUSOFT.filter((a) => a.type === "trigger");
}

export function getCommusoftActions(): ActionType[] {
  return ACTION_TYPES_COMMUSOFT.filter((a) => a.type === "action");
}

const ACTION_TYPES_SIMPRO: ActionType[] = [
  // Triggers (delivered via Simpro webhook — events: job.created, job.stage.*, job.status, etc.)

  // Job triggers
  {
    action_key: "new_job",
    label: "New Job",
    type: "trigger",
    description:
      "Fires when a new job is created in Simpro (job.created). Use it to kick off scheduling, customer notifications, or sync with other systems.",
  },
  {
    action_key: "job_stage_pending",
    label: "Job Pending",
    type: "trigger",
    description:
      "Fires when a job enters the Pending stage in Simpro (job.stage.pending). Use to notify staff, hold scheduling, or trigger a follow-up workflow.",
  },
  {
    action_key: "job_stage_in_progress",
    label: "Job In Progress",
    type: "trigger",
    description:
      "Fires when a job moves to In Progress in Simpro (job.stage.progress). Ideal for sending customer updates or starting a time-tracking workflow.",
  },
  {
    action_key: "job_stage_complete",
    label: "Job Completed",
    type: "trigger",
    description:
      "Fires when a job's stage is set to Complete in Simpro (job.stage.complete). Ideal for post-job follow-ups — request reviews, send invoices, or push data to accounting.",
  },
  {
    action_key: "job_stage_invoiced",
    label: "Job Invoiced",
    type: "trigger",
    description:
      "Fires when a job moves to the Invoiced stage in Simpro (job.stage.invoiced). Use to notify the customer, sync to accounting, or close related tasks.",
  },
  {
    action_key: "job_stage_archived",
    label: "Job Archived",
    type: "trigger",
    description:
      "Fires when a job is archived in Simpro (job.stage.archived). Use for end-of-lifecycle actions like reporting, data exports, or cleanup tasks.",
  },
  {
    action_key: "job_status_changed",
    label: "Job Status Changed",
    type: "trigger",
    description:
      "Fires whenever a job's custom status changes in Simpro (job.status). Optionally filter to a specific status in the trigger config.",
  },

  // Quote / Estimate triggers
  {
    action_key: "new_quote",
    label: "New Quote",
    type: "trigger",
    description:
      "Fires when a new quote is created in Simpro (quote.created). Useful for tracking the sales pipeline or notifying your team of new estimates.",
  },
  {
    action_key: "quote_accepted",
    label: "Quote Accepted",
    type: "trigger",
    description:
      "Fires when a quote's status changes to Accepted in Simpro (quote.status). The moment a prospect converts to confirmed work — trigger job creation, scheduling, or a confirmation email.",
  },
  {
    action_key: "quote_status_changed",
    label: "Quote Status Changed",
    type: "trigger",
    description:
      "Fires whenever a quote's status changes in Simpro (quote.status). Use to track quote progress, send follow-ups at each stage, or update your CRM.",
  },

  // Customer triggers
  {
    action_key: "new_company_customer",
    label: "New Company Customer",
    type: "trigger",
    description:
      "Fires when a new business (company) customer is created in Simpro (company.customer.created). Use to sync to your CRM, send a welcome email, or set up a project workspace.",
  },
  {
    action_key: "new_individual_customer",
    label: "New Individual Customer",
    type: "trigger",
    description:
      "Fires when a new individual customer is created in Simpro (individual.customer.created). Use to trigger onboarding sequences, sync contacts, or send welcome communications.",
  },

  // Lead triggers
  {
    action_key: "new_lead",
    label: "New Lead",
    type: "trigger",
    description:
      "Fires when a new lead is created in Simpro (lead.created). Push the lead into your CRM, notify your sales team, or start a follow-up sequence automatically.",
  },
  {
    action_key: "lead_status_changed",
    label: "Lead Status Changed",
    type: "trigger",
    description:
      "Fires when a lead's status changes in Simpro (lead.status). Scope to a specific status to trigger follow-ups or handoff workflows at the right moment.",
  },

  // Invoice / Payment triggers
  {
    action_key: "invoice_created",
    label: "Invoice Created",
    type: "trigger",
    description:
      "Fires when a new invoice is generated in Simpro (invoice.created). Use to notify the customer, sync to accounting software, or start a payment-chase workflow.",
  },
  {
    action_key: "payment_received",
    label: "Payment Received",
    type: "trigger",
    description:
      "Fires when a payment is recorded against an invoice in Simpro (payment.created). Use to send a receipt, update your accounts, or close off a job workflow.",
  },

  // ── New triggers ─────────────────────────────────────────────────────────
  {
    action_key: "company_customer_updated",
    label: "Company Customer Updated",
    type: "trigger",
    description:
      "Fires when an existing company customer record is updated in Simpro (company.customer.updated). Use to sync changes to your CRM or notify your team of account updates.",
  },
  {
    action_key: "individual_customer_updated",
    label: "Individual Customer Updated",
    type: "trigger",
    description:
      "Fires when an existing individual customer record is updated in Simpro (individual.customer.updated). Useful for keeping contact details in sync across systems.",
  },
  {
    action_key: "job_updated",
    label: "Job Updated",
    type: "trigger",
    description:
      "Fires whenever a job record is updated in Simpro (job.updated). Use to react to any field change — description, assigned staff, scheduled date, or custom fields.",
  },
  {
    action_key: "new_schedule",
    label: "New Schedule",
    type: "trigger",
    description:
      "Fires when a new schedule block is created in Simpro for a job, lead, quote, or activity (schedule.created). Use to notify technicians, sync calendars, or start pre-visit workflows.",
  },
  {
    action_key: "new_site",
    label: "New Site",
    type: "trigger",
    description:
      "Fires when a new site is created in Simpro (site.created). Use to set up site records in other systems, notify the relevant customer, or kick off a site-setup workflow.",
  },
  {
    action_key: "quote_updated",
    label: "Quote Updated",
    type: "trigger",
    description:
      "Fires whenever a quote is updated in Simpro (quote.updated). Ideal for tracking revisions, notifying clients of changes, or re-syncing quote data to your CRM.",
  },
  {
    action_key: "schedule_updated",
    label: "Schedule Updated",
    type: "trigger",
    description:
      "Fires when an existing schedule block is modified in Simpro (schedule.updated). Use to push rescheduling notifications to customers or update external calendars.",
  },
  {
    action_key: "site_updated",
    label: "Site Updated",
    type: "trigger",
    description:
      "Fires when a site record is updated in Simpro (site.updated). Use to keep site details in sync across your CRM, accounting system, or field service platform.",
  },

  // ── Actions (CREATE) ──────────────────────────────────────────────────────
  {
    action_key: "create_company_customer",
    label: "Create Company Customer",
    type: "action",
    description:
      "Creates a new business (company) customer record in Simpro using data from the workflow. Useful when syncing leads or clients from another system.",
  },
  {
    action_key: "create_contact",
    label: "Create Contact",
    type: "action",
    description:
      "Creates a new contact person under an existing customer in Simpro. Map first name, last name, email, phone, and role from earlier workflow steps.",
  },
  {
    action_key: "create_individual_customer",
    label: "Create Individual Customer",
    type: "action",
    description:
      "Creates a new individual customer record in Simpro using data from the workflow. Map name, email, phone, and address from earlier workflow steps.",
  },
  {
    action_key: "create_lead",
    label: "Create Lead",
    type: "action",
    description:
      "Creates a new lead record in Simpro from workflow data. Map customer details, description, and source from earlier steps to capture inbound enquiries automatically.",
  },
  {
    action_key: "create_schedule_block",
    label: "Create Schedule Block(s)",
    type: "action",
    description:
      "Creates a new schedule block in Simpro against a job, quote, lead, or activity. Map staff, date, start/end time, and notes from earlier workflow steps.",
  },
  {
    action_key: "create_job",
    label: "Create Service Job",
    type: "action",
    description:
      "Creates a new service job in Simpro linked to a customer. Map customer ID, description, status, and address fields from earlier workflow steps.",
  },
  {
    action_key: "create_quote",
    label: "Create Service Quote",
    type: "action",
    description:
      "Creates a new service quote in Simpro against a customer or site. Map description, sections, and cost items from earlier workflow steps.",
  },
  {
    action_key: "create_site",
    label: "Create Site",
    type: "action",
    description:
      "Creates a new site record in Simpro under an existing customer. Map address, name, and contact details from earlier workflow steps.",
  },
  {
    action_key: "update_job",
    label: "Update Job",
    type: "action",
    description:
      "Updates fields on an existing Simpro job — change stage, status, description, or assigned staff. Only the fields you provide are changed.",
  },

  // ── Actions (SEARCH / FIND) ───────────────────────────────────────────────
  {
    action_key: "find_company_customer",
    label: "Find Company Customer",
    type: "action",
    description:
      "Searches for a company customer in Simpro by name, email, or phone. Returns the first match. Optionally creates a new company customer if none are found.",
  },
  {
    action_key: "find_contact",
    label: "Find Contact",
    type: "action",
    description:
      "Searches for a contact under a customer in Simpro by name or email. Returns the first match. Optionally creates a new contact if none are found.",
  },
  {
    action_key: "find_individual_customer",
    label: "Find Individual Customer",
    type: "action",
    description:
      "Searches for an individual customer in Simpro by name, email, or phone. Returns the first match. Optionally creates a new individual customer if none are found.",
  },
  {
    action_key: "find_job",
    label: "Find Job",
    type: "action",
    description:
      "Searches for a job in Simpro by job number, customer ID, or status. Returns the first match for use in downstream workflow steps.",
  },
  {
    action_key: "find_quote",
    label: "Find Quote",
    type: "action",
    description:
      "Searches for a quote in Simpro by quote number, customer ID, or status. Returns the first match for use in downstream workflow steps.",
  },
  {
    action_key: "find_schedule",
    label: "Find Schedule",
    type: "action",
    description:
      "Searches for a schedule block in Simpro by job ID, staff member, or date range. Returns the first match for use in downstream workflow steps.",
  },
  {
    action_key: "find_site",
    label: "Find Site",
    type: "action",
    description:
      "Searches for a site in Simpro by name, address, or customer ID. Returns the first match. Optionally creates a new site if none are found.",
  },
];

export function getSimproTriggers(): ActionType[] {
  return ACTION_TYPES_SIMPRO.filter((a) => a.type === "trigger");
}

export function getSimproActions(): ActionType[] {
  return ACTION_TYPES_SIMPRO.filter((a) => a.type === "action");
}
