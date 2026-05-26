import { supabase } from "../../../config/db.config.js";
import { CreateMappingDTO } from "./mapping.dto.js";

type MappingEntry = {
  mapping_type: "dynamic" | "static" | "template";
  destination_field: string;
  source_node_id: string | null;
  source_field: string | null;
  static_value: string | null;
  template: string | null;
};

function validate(m: CreateMappingDTO) {
  // Treat whitespace-only strings as empty — otherwise a UI bug can persist
  // source_field=" " which silently resolves to undefined at execution time.
  const nonEmpty = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0;

  if (!nonEmpty(m.destination_field)) {
    throw new Error(`destination_field is required and must be a non-empty string`);
  }
  if (m.mapping_type === "dynamic") {
    if (!nonEmpty(m.source_node_id) || !nonEmpty(m.source_field)) {
      throw new Error(
        `Dynamic mapping for destination="${m.destination_field}" requires non-empty source_node_id and source_field`
      );
    }
  }
  if (m.mapping_type === "static") {
    if (m.static_value === undefined || m.static_value === null) {
      throw new Error(
        `Static mapping for destination="${m.destination_field}" requires static_value`
      );
    }
  }
  if (m.mapping_type === "template") {
    if (!nonEmpty(m.source_node_id) || !nonEmpty(m.template)) {
      throw new Error(
        `Template mapping for destination="${m.destination_field}" requires non-empty source_node_id and template`
      );
    }
  }
}

function toEntry(m: CreateMappingDTO): MappingEntry {
  return {
    mapping_type: m.mapping_type,
    destination_field: m.destination_field,
    source_node_id: m.source_node_id ?? null,
    source_field: m.source_field ?? null,
    static_value: m.static_value ?? null,
    template: m.template ?? null,
  };
}

export async function createMappingService(nodeId: string, payload: CreateMappingDTO) {
  console.log(`[MappingService] Add/update mapping | node=${nodeId} destination=${payload.destination_field}`);
  validate(payload);

  // Read current row, append (or replace) the entry, then upsert
  const { data: existing, error: fetchError } = await supabase
    .from("workflow_field_mappings")
    .select("id, mappings")
    .eq("workflow_node_id", nodeId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);

  const current: MappingEntry[] = existing?.mappings ?? [];
  const updated = [
    ...current.filter((m) => m.destination_field !== payload.destination_field),
    toEntry(payload),
  ];

  const { data, error } = await supabase
    .from("workflow_field_mappings")
    .upsert({ workflow_node_id: nodeId, mappings: updated }, { onConflict: "workflow_node_id" })
    .select()
    .single();

  if (error) throw new Error(error.message);
  console.log(`[MappingService] Mapping saved | node=${nodeId} total=${updated.length}`);
  return data;
}

export async function getMappingsByNodeService(nodeId: string) {
  console.log(`[MappingService] Fetching mappings | workflow_node_id=${nodeId}`);

  const { data, error } = await supabase
    .from("workflow_field_mappings")
    .select("*")
    .eq("workflow_node_id", nodeId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const mappings: MappingEntry[] = data?.mappings ?? [];
  console.log(`[MappingService] Found ${mappings.length} mapping(s) for node ${nodeId}`);
  return mappings;
}

/**
 * createMappingsBulkService
 *
 * Replaces ALL mappings for a node in a single upsert — one DB row per node.
 */
export async function createMappingsBulkService(nodeId: string, mappings: CreateMappingDTO[]) {
  console.log(`[MappingService] Bulk upsert | node=${nodeId} count=${mappings.length}`);

  for (const m of mappings) validate(m);

  const entries = mappings.map(toEntry);

  const { data, error } = await supabase
    .from("workflow_field_mappings")
    .upsert({ workflow_node_id: nodeId, mappings: entries }, { onConflict: "workflow_node_id" })
    .select()
    .single();

  if (error) throw new Error(error.message);

  console.log(`[MappingService] Bulk upsert complete | node=${nodeId} saved=${entries.length}`);
  entries.forEach((m) =>
    console.log(`  ✓ [${m.mapping_type}] ${m.source_field ?? m.static_value} → ${m.destination_field}`)
  );

  return data;
}

export async function deleteMappingService(nodeId: string, destinationField: string) {
  console.log(`[MappingService] Deleting mapping | node=${nodeId} destination=${destinationField}`);

  const { data: existing, error: fetchError } = await supabase
    .from("workflow_field_mappings")
    .select("id, mappings")
    .eq("workflow_node_id", nodeId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new Error("No mappings found for this node");

  const updated = (existing.mappings as MappingEntry[]).filter(
    (m) => m.destination_field !== destinationField
  );

  const { error } = await supabase
    .from("workflow_field_mappings")
    .update({ mappings: updated })
    .eq("id", existing.id);

  if (error) throw new Error(error.message);

  console.log(`[MappingService] Mapping deleted | node=${nodeId} destination=${destinationField}`);
  return { message: "Mapping deleted successfully" };
}
