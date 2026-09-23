import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import type pg from "pg";
import { transaction } from "../db.ts";
import { decrypt, encrypt, type WaConfig } from "./security.ts";

// The account/category/key envelope prevents swapping ciphertext between employees.
export function sealLinked(
  value: unknown,
  user: string,
  category: string,
  id: string,
  config: WaConfig,
) {
  return encrypt(
    JSON.stringify({ user, category, id, value }, BufferJSON.replacer),
    config,
  );
}
export function openLinked(
  value: string,
  user: string,
  category: string,
  id: string,
  config: WaConfig,
) {
  const result = JSON.parse(decrypt(value, config), BufferJSON.reviver);
  if (result.user !== user || result.category !== category || result.id !== id)
    throw new Error("Linked credential ownership mismatch");
  return result.value;
}
export async function linkedAuth(
  pool: pg.Pool,
  user: string,
  config: WaConfig,
) {
  const read = async (category: string, id: string) => {
    const row = (
      await pool.query(
        "SELECT encrypted_value FROM whatsapp_linked_auth WHERE user_id=$1 AND category=$2 AND key_id=$3",
        [user, category, id],
      )
    ).rows[0];
    return row
      ? openLinked(row.encrypted_value, user, category, id, config)
      : null;
  };
  const creds = (await read("credentials", "main")) || initAuthCreds();
  const state: AuthenticationState = {
    creds,
    keys: {
      async get(type, ids) {
        const result: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        for (const id of ids) {
          const value = await read(type, id);
          result[id] =
            type === "app-state-sync-key" && value
              ? proto.Message.AppStateSyncKeyData.fromObject(value)
              : value;
        }
        return result;
      },
      async set(data) {
        await transaction(pool, async (db) => {
          for (const [category, values] of Object.entries(data))
            for (const [id, value] of Object.entries(values || {})) {
              if (value == null)
                await db.query(
                  "DELETE FROM whatsapp_linked_auth WHERE user_id=$1 AND category=$2 AND key_id=$3",
                  [user, category, id],
                );
              else
                await db.query(
                  "INSERT INTO whatsapp_linked_auth(user_id,category,key_id,encrypted_value) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,category,key_id) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value",
                  [
                    user,
                    category,
                    id,
                    sealLinked(value, user, category, id, config),
                  ],
                );
            }
        });
      },
    },
  };
  return {
    state,
    async save() {
      await pool.query(
        "INSERT INTO whatsapp_linked_auth(user_id,category,key_id,encrypted_value) VALUES($1,'credentials','main',$2) ON CONFLICT(user_id,category,key_id) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value",
        [user, sealLinked(creds, user, "credentials", "main", config)],
      );
    },
  };
}
