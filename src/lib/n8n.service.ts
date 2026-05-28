// src/lib/n8n.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// n8n integration service — trigger n8n workflows from Node.js backend
// Used by webhook receivers (ServiceM8, GHL, Commusoft) to kick off automation

import axios from "axios";

const N8N_BASE_URL  = process.env.N8N_BASE_URL  || "http://localhost:5678";
const N8N_API_KEY   = process.env.N8N_API_KEY   || "";
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:8000";

// ── Trigger n8n via Webhook URL ───────────────────────────────────────────────
// In n8n UI: add a "Webhook" trigger node, copy its path, use here
export const triggerN8nWebhook = async (
  webhookPath: string,
  payload: Record<string, any>
): Promise<any> => {
  try {
    const url = `${N8N_BASE_URL}/webhook/${webhookPath}`;
    const response = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });
    return response.data;
  } catch (err: any) {
    // Non-blocking — log but don't crash the main request
    console.error(`[n8n] webhook trigger failed (${webhookPath}):`, err.message);
    return null;
  }
};

// ── Call Python AI Service ────────────────────────────────────────────────────
// Helper used in webhook handlers to call Python before triggering n8n
export const callAIService = async (
  endpoint: string,
  payload: Record<string, any>
): Promise<any> => {
  try {
    const url = `${AI_SERVICE_URL}${endpoint}`;
    const response = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000, // AI calls can take longer
    });
    return response.data;
  } catch (err: any) {
    console.error(`[ai-service] call failed (${endpoint}):`, err.message);
    return null;
  }
};

// ── Specific trigger helpers — one per automation flow ────────────────────────

// Called when ServiceM8 job is COMPLETED
// n8n flow: job.completed → AI summary → email client → update GHL
export const onJobCompleted = async (jobData: {
  job_uuid: string;
  client_id: string;
  job_description?: string;
  contact_email?: string;
  engineer_name?: string;
  total_amount?: string;
}) => {
  // Step 1: Get AI summary from Python
  const aiResult = await callAIService("/ai/jobs/summarize-by-id", {
    job_uuid: jobData.job_uuid,
    client_id: jobData.client_id,
  });

  // Step 2: Trigger n8n with job data + AI summary
  await triggerN8nWebhook("job-completed", {
    ...jobData,
    ai_summary:    aiResult?.summary    || null,
    ai_key_points: aiResult?.key_points || [],
  });
};

// Called when a new lead arrives from GHL/website
// n8n flow: new.lead → AI score+extract → update GHL → send welcome email
export const onNewLead = async (leadData: {
  location_id: string;
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
  source?: string;
}) => {
  // Step 1: Score and extract lead info via Python AI
  const aiResult = await callAIService("/ai/leads/score-and-extract", {
    text:        leadData.message || "",
    source:      leadData.source || "ghl",
    location_id: leadData.location_id,
  });

  // Step 2: Trigger n8n with lead + AI scores
  await triggerN8nWebhook("new-lead", {
    ...leadData,
    ai_score:    aiResult?.score    || null,
    ai_extracted: aiResult?.extracted || null,
  });
};

// Called when a new job is CREATED (not yet completed)
// n8n flow: new.job → AI categorize → assign staff → notify on Slack
export const onJobCreated = async (jobData: {
  job_uuid: string;
  client_id: string;
  job_description?: string;
  job_address?: string;
}) => {
  // Auto-categorize with AI
  const aiResult = await callAIService("/ai/jobs/categorize", {
    description: jobData.job_description || "",
  });

  await triggerN8nWebhook("job-created", {
    ...jobData,
    ai_category: aiResult?.category  || null,
    ai_priority: aiResult?.priority  || null,
  });
};

// Called daily via your own cron / scheduler
// n8n flow: daily.report → AI analytics → send email report
export const triggerDailyReport = async (clientId: string) => {
  await triggerN8nWebhook("daily-report", {
    client_id: clientId,
    date: new Date().toISOString().split("T")[0],
  });
};
