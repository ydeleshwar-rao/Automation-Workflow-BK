import { supabase } from "../../../config/db.config.js";
import { CreateNodeDTO, UpdateNodeDTO } from "./node.dto.js";
import { createMappingsBulkService } from "../field_mapping/mapping.service.js";
import { createPollingSubscription } from "../../polling-engine/polling.service.js";
import { getDefaultPollInterval } from "../../polling-engine/polling.runner.js";

// Integrations that use the polling engine directly at node-creation time.
// Leadshub and ServiceM8 are subscribed through the hybrid subscription
// endpoint during publish/test so webhook-capable triggers do not get a stale
// polling subscription in the background.
const POLLING_INTEGRATIONS = new Set(["commusoft", "simpro"]);

export async function createNodeService(
  workflowId: string,
  payload: CreateNodeDTO
) {
  console.log(`[NodeService] Creating node | workflow_id=${workflowId} type=${payload.type} integration=${payload.integration_key}`);

  const { data, error } = await supabase
    .from("workflow_nodes")
    .insert({
      workflow_id: workflowId,
      integration_key: payload.integration_key,
      type: payload.type,
      node_category: payload.node_category ?? payload.type,
      config: payload.config || {},
      sample_payload: payload.sample_payload || {},
      output_schema: payload.output_schema || {},
      position: payload.position || 0,
      action_key: payload.action_key,
    })
    .select()
    .single();

  if (error) {
    console.error(`[NodeService] Failed to create node:`, error.message);
    throw new Error(error.message);
  }

  console.log(`[NodeService] Node created successfully | node_id=${data.id}`);

  // Auto-create polling subscription for polling trigger nodes
  if (
    payload.type === "trigger" &&
    POLLING_INTEGRATIONS.has(payload.integration_key) &&
    payload.action_key
  ) {
    try {
      // Look up user_id from the workflow
      const { data: workflow } = await supabase
        .from("workflows")
        .select("user_id")
        .eq("id", workflowId)
        .single();

      if (workflow?.user_id) {
        const sub = await createPollingSubscription({
          workflow_id: workflowId,
          node_id:     data.id,
          user_id:     workflow.user_id,
          integration_key: payload.integration_key,
          event_key:   payload.action_key,
          config:      payload.config || {},
          poll_interval: getDefaultPollInterval(),
        });
        console.log(
          `[NodeService] ✅ Polling subscription auto-created | sub_id=${sub.id} event=${payload.action_key} integration=${payload.integration_key}`
        );
      } else {
        console.warn(`[NodeService] ⚠ Could not auto-create subscription — workflow ${workflowId} has no user_id`);
      }
    } catch (subErr: any) {
      // Non-fatal — node was created, subscription can be created manually
      console.error(`[NodeService] ⚠ Failed to auto-create polling subscription | node_id=${data.id} error=${subErr?.message}`);
    }
  }

  return data;
}

export async function updateNodeService(
  nodeId: string,
  updates: UpdateNodeDTO
) {
  // Split mappings off so they don't get written into workflow_nodes —
  // workflow_field_mappings is a separate table with its own validator.
  const { mappings, ...nodeUpdates } = updates;

  console.log(
    `[NodeService] Updating node | node_id=${nodeId}`,
    Object.keys(nodeUpdates),
    mappings ? `+mappings(${mappings.length})` : ""
  );

  const { data, error } = await supabase
    .from("workflow_nodes")
    .update({
      ...nodeUpdates,
      updated_at: new Date().toISOString(),
    })
    .eq("id", nodeId)
    .select()
    .single();

  if (error) {
    console.error(`[NodeService] Failed to update node ${nodeId}:`, error.message);
    throw new Error(error.message);
  }

  // When mappings are provided, rewrite workflow_field_mappings in the same
  // request so config/sample_payload and mappings cannot drift apart. This
  // closes the window where the UI forgets to call /mappings/bulk after a
  // template edit, which previously caused stale source_field at execution.
  if (Array.isArray(mappings)) {
    if (mappings.length === 0) {
      console.warn(
        `[NodeService] mappings=[] received for node ${nodeId} — leaving existing mappings untouched. ` +
        `Use DELETE /nodes/:id/mappings/:destinationField to remove individual rows.`
      );
    } else {
      await createMappingsBulkService(nodeId, mappings);
      console.log(`[NodeService] Mappings re-synced atomically | node_id=${nodeId} count=${mappings.length}`);
    }
  }

  console.log(`[NodeService] Node updated | node_id=${nodeId}`);
  return data;
}

/**
 * saveSamplePayloadService
 *
 * Called when a test webhook fires — stores the raw incoming payload on the trigger
 * node so it can be used as a schema reference when the user builds field mappings.
 *
 * output_schema is derived as a flat key→null map so the UI can list available
 * source fields without exposing real data.
 */
export async function saveSamplePayloadService(
  nodeId: string,
  samplePayload: Record<string, any>
) {
  const outputSchema = Object.keys(samplePayload).reduce<Record<string, null>>(
    (acc, key) => ({ ...acc, [key]: null }),
    {}
  );

  console.log(`[NodeService] Saving sample_payload for trigger node | node_id=${nodeId}`);
  console.log(`[NodeService] sample_payload keys:`, Object.keys(samplePayload));

  const { data, error } = await supabase
    .from("workflow_nodes")
    .update({
      sample_payload: samplePayload,
      output_schema: outputSchema,
      updated_at: new Date().toISOString(),
    })
    .eq("id", nodeId)
    .select()
    .single();

  if (error) {
    console.error(`[NodeService] Failed to save sample_payload for node ${nodeId}:`, error.message);
    throw new Error(error.message);
  }

  console.log(`[NodeService] sample_payload saved | node_id=${nodeId} | keys_count=${Object.keys(samplePayload).length}`);
  return data;
}

export async function getNodesByWorkflowService(workflowId: string) {
  const { data, error } = await supabase
    .from("workflow_nodes")
    .select("*")
    .eq("workflow_id", workflowId)
    .order("position", { ascending: true });

  if (error) throw new Error(error.message);
  return data;
}

export async function deleteNodeService(nodeId: string) {
  const { error } = await supabase
    .from("workflow_nodes")
    .delete()
    .eq("id", nodeId);

  if (error) throw new Error(error.message);

  return { message: "Node deleted successfully" };
}
