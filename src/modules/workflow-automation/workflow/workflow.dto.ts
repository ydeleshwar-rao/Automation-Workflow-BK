// workflow.dto.ts

export interface CreateWorkflowDTO {
  name: string;
  tag?: string;
  user_id: string;
  workflow_id: string;
  folder_id?: string | null;
  position?: number;
}

export interface UpdateWorkflowDTO {
  name?: string;
  tag?: string;
  status?: "draft" | "active" | "paused";
  folder_id?: string | null;
  position?: number;
  last_edited_by?: string;
  last_edited_by_name?: string;
}

export interface ActivateWorkflowDTO {
  status: "active" | "paused";
}

export interface BulkMoveWorkflowsDTO {
  ids: string[];
  folder_id: string | null;
}

export interface ReorderWorkflowsDTO {
  items: { id: string; folder_id: string | null; position: number }[];
}
