// template.dto.ts

export type WorkflowTemplateStatus = "active" | "archived";
export type WorkflowNodeType = "trigger" | "action" | "condition";

export interface CreateTemplateFromWorkflowDTO {
  source_workflow_id: string;
  name: string;
  description?: string;
  category?: string;
  tag?: string;
  created_by: string;
  is_public?: boolean;
}

export interface UpdateTemplateDTO {
  name?: string;
  description?: string | null;
  category?: string | null;
  tag?: string | null;
  is_public?: boolean;
  status?: WorkflowTemplateStatus;
  template_folder_id?: string | null;
}

export interface ListTemplatesQuery {
  created_by?: string;
  is_public?: string | boolean;
  category?: string;
  status?: WorkflowTemplateStatus;
  template_folder_id?: string;
}

// credential_overrides is keyed by template_node_id, each value merged into config
// e.g. { "<template_node_id>": { smtp_id: "abc", webhook_id: "xyz" } }
export interface ApplyTemplateDTO {
  name: string;
  user_id: string;
  tag?: string;
  credential_overrides?: Record<string, Record<string, any>>;
}
