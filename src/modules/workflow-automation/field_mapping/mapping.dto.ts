export interface CreateMappingDTO {
  // mapping_type decides how the value is resolved at execution time:
  //   'dynamic'  — pull the value from source_node's output using source_field path
  //   'static'   — always use the hardcoded static_value regardless of incoming data
  //   'template' — raw string containing {{map:sourceField|label|fallback}} tokens
  //                mixed with static text; each token is resolved against
  //                source_node's output at execution time, falling back to the
  //                third segment (sample value) when the source field is missing
  mapping_type: "dynamic" | "static" | "template";

  // Required when mapping_type = 'dynamic' OR 'template'
  // The workflow_nodes.id of the node whose output provides the source value
  // (usually the trigger node, but can be a previous action node)
  source_node_id?: string;

  // Required when mapping_type = 'dynamic'
  // Dot-notation path into source_node's output — e.g. "fromName" or "body.customer.email"
  source_field?: string;

  // Required when mapping_type = 'static'
  // The hardcoded value that is always used regardless of incoming webhook data
  static_value?: string;

  // Required when mapping_type = 'template'
  // Raw template string, e.g. "Hi {{map:name|Name|John}} — order {{map:id|Id|42}}"
  template?: string;

  // The field key in the action's input this maps TO
  // e.g. "fromName", "to", "subject"
  destination_field: string;

  transformation?: Record<string, any>;
}
