import {
  AuthenticationState,
  initAuthCreds,
  BufferJSON,
  proto,
} from "@whiskeysockets/baileys";
import { supabase } from "../../../../config/db.config.js";

/**
 * Supabase-backed Baileys auth state.
 * Persists WhatsApp session credentials across server restarts.
 */
export async function useSupabaseAuthState(userId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const { data: rows, error: loadError } = await supabase
    .from("whatsapp_auth_keys")
    .select("key_id, key_data")
    .eq("user_id", userId);
  if (loadError) {
    throw new Error(`Failed to load WhatsApp auth keys: ${loadError.message}`);
  }

  const keyMap: Record<string, any> = {};
  for (const row of rows ?? []) {
    keyMap[row.key_id] = row.key_data;
  }

  const creds = keyMap["creds"]
    ? JSON.parse(JSON.stringify(keyMap["creds"]), BufferJSON.reviver)
    : initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type: string, ids: string[]) => {
        const result: Record<string, any> = {};
        for (const id of ids) {
          const keyId = `${type}-${id}`;
          let value = keyMap[keyId];
          if (value) {
            value = JSON.parse(JSON.stringify(value), BufferJSON.reviver);
            if (type === "app-state-sync-key") {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
          }
          result[id] = value;
        }
        return result;
      },

      set: async (data: Record<string, Record<string, any>>) => {
        const upsertRows: any[] = [];
        const deleteKeys: string[] = [];

        for (const [type, typeData] of Object.entries(data)) {
          for (const [id, value] of Object.entries(typeData)) {
            const keyId = `${type}-${id}`;
            if (value) {
              const keyData = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
              upsertRows.push({ user_id: userId, key_id: keyId, key_data: keyData });
              keyMap[keyId] = keyData;
            } else {
              deleteKeys.push(keyId);
              delete keyMap[keyId];
            }
          }
        }

        if (upsertRows.length > 0) {
          const { error } = await supabase
            .from("whatsapp_auth_keys")
            .upsert(upsertRows, { onConflict: "user_id,key_id" });
          if (error) {
            throw new Error(`Failed to save WhatsApp auth keys: ${error.message}`);
          }
        }

        for (const keyId of deleteKeys) {
          const { error } = await supabase
            .from("whatsapp_auth_keys")
            .delete()
            .eq("user_id", userId)
            .eq("key_id", keyId);
          if (error) {
            throw new Error(`Failed to delete WhatsApp auth key ${keyId}: ${error.message}`);
          }
        }
      },
    },
  };

  const saveCreds = async () => {
    const credsData = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    const { error } = await supabase.from("whatsapp_auth_keys").upsert(
      { user_id: userId, key_id: "creds", key_data: credsData },
      { onConflict: "user_id,key_id" }
    );
    if (error) {
      throw new Error(`Failed to save WhatsApp creds: ${error.message}`);
    }
    keyMap["creds"] = credsData;
  };

  return { state, saveCreds };
}
