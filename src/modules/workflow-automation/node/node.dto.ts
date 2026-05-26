export interface CreateNodeDTO {
  integration_key: string;
  type: "trigger" | "action" | "condition";
  // node_category mirrors 'type' but is the explicit DB column used for schema-level logic
  node_category?: "trigger" | "action" | "condition";
  config?: Record<string, any>;
  // sample_payload: raw incoming payload snapshot — set on trigger nodes, used as mapping schema reference
  sample_payload?: Record<string, any>;
  // output_schema: flat key→null map derived from sample_payload, used by UI to list available fields
  output_schema?: Record<string, null>;
  position?: number;
  action_key?: string;
}

export interface UpdateNodeDTO {
  integration_key?: string;
  node_category?: "trigger" | "action" | "condition";
  config?: Record<string, any>;
  sample_payload?: Record<string, any>;
  output_schema?: Record<string, null>;
  position?: number;
  is_active?: boolean;
  action_key?: string;
  // Optional — when present, workflow_field_mappings is rewritten atomically
  // together with the node row so config and mappings cannot drift apart.
  // Shape matches CreateMappingDTO[] from field_mapping/mapping.dto.
  mappings?: Array<{
    mapping_type: "dynamic" | "static" | "template";
    destination_field: string;
    source_node_id?: string;
    source_field?: string;
    static_value?: string;
    template?: string;
    transformation?: Record<string, any>;
  }>;
}