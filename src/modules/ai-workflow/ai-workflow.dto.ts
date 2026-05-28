// ai-workflow.dto.ts
// ─────────────────────────────────────────────────────────────────────────────
// Data-transfer objects and request validation types for the AI Workflow module.

export interface CreateAiWorkflowDTO {
  user_id: string;
  name?: string;
  description?: string;
}

export interface UpdateAiWorkflowDTO {
  name?: string;
  description?: string;
  status?: "draft" | "active" | "paused";
  nodes?: unknown[];    // React Flow node array — opaque JSON
  edges?: unknown[];    // React Flow edge array — opaque JSON
  viewport?: { x: number; y: number; zoom: number };
}

export interface CreateExecutionDTO {
  workflow_id: string;
  trigger?: "manual" | "schedule" | "webhook";
}

export interface UpdateExecutionDTO {
  status?: "running" | "success" | "failed";
  node_results?: Record<string, unknown>;
  error?: string;
  finished_at?: string;
}
