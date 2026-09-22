import { randomUUID } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type pg from "pg";
import type { Db } from "../db.ts";
import { transaction } from "../db.ts";
import { HttpError, hashToken, businessDay } from "../domain.ts";
import * as repo from "../repository.ts";
import type { User } from "../../shared/contracts.ts";
import { customerSchema } from "../../shared/contracts.ts";
import type { WaAccount, WaRules, WaTemplate } from "../../shared/whatsapp.ts";
import {
  decrypt,
  encrypt,
  normalizeNumber,
  maskNumber,
  providerError,
  safeMessageTime,
  windowOpen,
  type WaConfig,
} from "./security.ts";
import { graphApi, MetaError, type GraphApi, type PhoneInfo } from "./graph.ts";

type Json = Record<string, unknown>;
const object = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
export type AccountRow = {
  id: string;
  user_id: string;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string;
  token_reference: string | null;
  token_encrypted: string | null;
  connection_status: string;
  active: boolean;
  version: number;
};
export const publicAccountsSQL = `SELECT a.id,a.user_id AS "userId",u.name AS "userName",u.active,a.waba_id AS "wabaId",a.phone_number_id AS "phoneNumberId",a.display_phone_number AS "displayPhoneNumber",a.country_calling_code AS "countryCallingCode",a.verified_name AS "verifiedName",a.connection_status AS "connectionStatus",a.connected_at AS "connectedAt",a.last_webhook_at AS "lastWebhookAt",a.last_checked_at AS "lastCheckedAt",a.subscription_status AS "subscriptionStatus",a.last_error AS "lastError",a.last_error_code AS "lastErrorCode",a.version,(a.token_reference IS NOT NULL OR a.token_encrypted IS NOT NULL) AS "credentialConfigured" FROM whatsapp_accounts a JOIN users u ON u.id=a.user_id`;
export async function accounts(db: Db, user: User): Promise<WaAccount[]> {
  return (
    await db.query(
      publicAccountsSQL +
        (user.role === "admin" ? "" : " WHERE a.user_id=$1") +
        " ORDER BY a.created_at",
      user.role === "admin" ? [] : [user.id],
    )
  ).rows;
}
export async function rules(db: Db): Promise<WaRules> {
  const row = (
    await db.query("SELECT data,version FROM whatsapp_settings WHERE id=1")
  ).rows[0];
  return { ...row.data, version: row.version };
}
export async function account(
  db: Db,
  id: string,
  user?: User,
  lock = false,
): Promise<AccountRow> {
  const r = await db.query(
    `SELECT a.*,u.active FROM whatsapp_accounts a JOIN users u ON u.id=a.user_id WHERE a.id::text=$1 ${user?.role === "sales" ? "AND a.user_id=$2" : ""} ${lock ? "FOR UPDATE OF a" : ""}`,
    [id, ...(user?.role === "sales" ? [user.id] : [])],
  );
  if (!r.rowCount) throw new HttpError(404, "WhatsApp绑定不存在或无权访问");
  return r.rows[0];
}
export function accountToken(row: AccountRow, config: WaConfig) {
  if (row.connection_status === "disconnected")
    throw new HttpError(409, "WhatsApp号码已断开连接");
  if (row.token_encrypted) return decrypt(row.token_encrypted, config);
  if (
    row.token_reference &&
    /^WHATSAPP_TOKEN_[A-Z0-9_]+$/.test(row.token_reference)
  ) {
    const value = process.env[row.token_reference];
    if (value) return value;
  }
  throw new HttpError(503, "该号码的服务端凭据未配置，请联系管理员");
}
export async function alert(
  db: Db,
  code: string,
  title: string,
  accountId: string | null = null,
  key = code,
) {
  await db.query(
    "INSERT INTO whatsapp_alerts(id,account_id,event_key,title,code) VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_key) DO UPDATE SET resolved_at=NULL",
    [randomUUID(), accountId, key, title, code],
  );
}
export async function connectionError(db: Db, row: AccountRow, error: unknown) {
  const code = error instanceof MetaError ? error.code : "CONNECTION";
  const message =
    error instanceof MetaError
      ? error.message
      : "连接检查失败，请检查服务端配置或重新授权";
  await db.query(
    "UPDATE whatsapp_accounts SET connection_status='error',last_error_code=$2,last_error=$3,last_checked_at=now(),updated_at=now() WHERE id=$1 AND connection_status<>'disconnected'",
    [row.id, code, message],
  );
  await alert(db, code, message, row.id, `connection:${row.id}`);
}
export async function verifyPhone(
  graph: GraphApi,
  wabaId: string,
  phoneId: string,
  token: string,
) {
  let after = "";
  for (let page = 0; page < 20; page++) {
    const result = await graph.request<{
      data: PhoneInfo[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(
      `${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100${after ? "&after=" + encodeURIComponent(after) : ""}`,
      token,
    );
    const phone = result.data?.find((p) => p.id === phoneId);
    if (phone) {
      if (!normalizeNumber(phone.display_phone_number))
        throw new HttpError(400, "Meta返回的业务号码无效");
      return phone;
    }
    if (!result.paging?.next || !result.paging.cursors?.after) break;
    after = result.paging.cursors.after;
  }
  throw new HttpError(403, "该Phone Number ID不属于已授权的WABA");
}
export async function bindAccount(
  pool: pg.Pool,
  config: WaConfig,
  input: {
    userId: string;
    wabaId: string;
    phone: PhoneInfo;
    token?: string;
    tokenReference?: string;
    subscriptionStatus?: string;
  },
  actor: User | null,
) {
  if (!/^\d+$/.test(input.wabaId) || !/^\d+$/.test(input.phone.id))
    throw new HttpError(400, "Meta号码ID格式无效");
  if (
    !input.token &&
    !/^WHATSAPP_TOKEN_[A-Z0-9_]+$/.test(input.tokenReference || "")
  )
    throw new HttpError(400, "缺少合法服务端凭据");
  const sealed = input.token ? encrypt(input.token, config) : null;
  return transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(825118)");
    await repo.activeOwner(db, input.userId);
    const existing = (
      await db.query(
        "SELECT * FROM whatsapp_accounts WHERE phone_number_id=$1 FOR UPDATE",
        [input.phone.id],
      )
    ).rows[0];
    if (existing && existing.user_id !== input.userId)
      throw new HttpError(
        409,
        "该号码已绑定其他员工，请管理员先核对并调整归属",
      );
    const id = existing?.id || randomUUID();
    await db.query(
      `INSERT INTO whatsapp_accounts(id,user_id,waba_id,phone_number_id,display_phone_number,country_calling_code,verified_name,token_encrypted,token_reference,subscription_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET waba_id=EXCLUDED.waba_id,display_phone_number=EXCLUDED.display_phone_number,country_calling_code=EXCLUDED.country_calling_code,verified_name=EXCLUDED.verified_name,token_encrypted=EXCLUDED.token_encrypted,token_reference=EXCLUDED.token_reference,connection_status='connected',connected_at=now(),last_error=NULL,last_error_code=NULL,credential_version=whatsapp_accounts.credential_version+1,version=whatsapp_accounts.version+1,subscription_status=EXCLUDED.subscription_status,updated_at=now()`,
      [
        id,
        input.userId,
        input.wabaId,
        input.phone.id,
        input.phone.display_phone_number,
        input.phone.country_code ||
          (() => {
            const n = parsePhoneNumberFromString(
              "+" + normalizeNumber(input.phone.display_phone_number),
            );
            return n ? "+" + n.countryCallingCode : "";
          })(),
        input.phone.verified_name || "",
        sealed,
        input.tokenReference || null,
        input.subscriptionStatus || "unknown",
      ],
    );
    await repo.audit(db, actor, "绑定WhatsApp号码", id, {
      userId: input.userId,
      phone: maskNumber(input.phone.display_phone_number),
    });
    return { id };
  });
}
export async function assignment(
  db: Db,
  customerId: string,
  from: string | null,
  to: string,
  actorId: string | null,
  reason: string,
) {
  await db.query(
    "INSERT INTO whatsapp_assignments(id,customer_id,from_user_id,to_user_id,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), customerId, from, to, actorId, reason],
  );
}
export async function conversation(
  db: Db,
  user: User,
  id: string,
  lock = false,
) {
  const s = repo.scope(user, "c", 2);
  const row = (
    await db.query(
      `SELECT v.*,c.owner_id,c.deleted_at,c.wa_needs_assignment,a.phone_number_id,a.user_id AS account_user_id,a.connection_status,u.active AS account_active FROM whatsapp_conversations v JOIN customers c ON c.id=v.customer_id JOIN whatsapp_accounts a ON a.id=v.account_id JOIN users u ON u.id=a.user_id WHERE v.id::text=$1 AND ${s.sql} AND c.deleted_at IS NULL ${user.role === "sales" ? "AND NOT v.conflict" : ""} ${lock ? "FOR UPDATE OF v,c" : ""}`,
      [id, ...s.params],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "会话不存在或无权访问");
  return row;
}

export function extractSuggestions(text: string) {
  const result: { field: string; value: string; evidence: string }[] = [];
  const add = (field: string, value: string, evidence: string) => {
    if (value.trim())
      result.push({
        field,
        value: value.trim().slice(0, 500),
        evidence: evidence.slice(0, 500),
      });
  };
  // 仅提取明确标签或关键词。所有结果都等待人工确认，不对姓名/国家作无依据猜测。
  for (const [field, pattern] of Object.entries({
    company: /(?:company(?: name)?|公司(?:名称)?)\s*[:：]\s*([^\n;；]+)/i,
    contact: /(?:my name is|姓名\s*[:：])\s*([^\n;；,.，。]+)/i,
    country: /(?:country|国家)\s*[:：]\s*([^\n;；]+)/i,
    city: /(?:city|城市)\s*[:：]\s*([^\n;；]+)/i,
    email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    quantity: /(?:quantity|qty|数量)\s*[:：]\s*([^\n;；]+)/i,
    specification: /(?:specifications?|规格|尺寸)\s*[:：]\s*([^\n;；]+)/i,
    projectType: /(?:project(?: type)?|项目(?:类型)?)\s*[:：]\s*([^\n;；]+)/i,
    purchaseTime:
      /(?:purchase(?: date| time)?|采购时间)\s*[:：]\s*([^\n;；]+)/i,
  })) {
    const m = text.match(pattern);
    if (m) add(field, m[1] || m[0], m[0]);
  }
  const products: [string, RegExp][] = [
    ["铝合金门窗", /alumin(?:ium|um) (?:windows?|doors?)|铝合金门窗/i],
    ["全铝室内门", /全铝室内门|all.aluminum interior doors?/i],
    ["铝木门", /铝木门|alumin(?:ium|um).wood doors?/i],
    ["铝合金隐形门", /隐形门|invisible doors?/i],
    ["入户门", /入户门|entrance doors?/i],
    ["偏轴门", /偏轴门|pivot doors?/i],
    ["艺术玻璃", /艺术玻璃|art glass/i],
    ["门窗五金", /门窗五金|door hardware|window hardware/i],
    ["工程门窗", /工程门窗|project windows?/i],
  ];
  const selected = products
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
  if (selected.length) add("product", selected.join("、"), text);
  if (text.length > 10) add("inquiry", text.slice(0, 500), text);
  return result;
}

export function createWhatsAppService(
  pool: pg.Pool,
  config: WaConfig,
  graph: GraphApi = graphApi(config),
) {
  async function inbound(
    db: Db,
    phoneId: string,
    profile: Json,
    message: Json,
    wabaId: string,
  ) {
    const messageId = str(message.id),
      waId = normalizeNumber(str(message.from));
    if (!messageId || !waId) return;
    const accountRow = (
      await db.query(
        "SELECT a.*,u.active FROM whatsapp_accounts a JOIN users u ON u.id=a.user_id WHERE phone_number_id=$1 AND waba_id=$2",
        [phoneId, wabaId],
      )
    ).rows[0] as AccountRow | undefined;
    if (!accountRow || accountRow.connection_status === "disconnected")
      throw new HttpError(409, "接收号码尚未连接，事件已保留等待管理员处理");
    // 与手工新建使用同一锁，避免并发重复客户；所有写入仍在事件事务中。
    await db.query("SELECT pg_advisory_xact_lock(825115)");
    if (
      (
        await db.query(
          "SELECT 1 FROM whatsapp_messages WHERE whatsapp_message_id=$1",
          [messageId],
        )
      ).rowCount
    )
      return;
    const existingConversation = (
      await db.query(
        "SELECT * FROM whatsapp_conversations WHERE account_id=$1 AND wa_id=$2",
        [accountRow.id, waId],
      )
    ).rows[0];
    let customerId: string | undefined = existingConversation?.customer_id;
    if (!customerId)
      customerId = (
        await db.query(
          "SELECT customer_id FROM whatsapp_identities WHERE wa_id=$1",
          [waId],
        )
      ).rows[0]?.customer_id;
    let ambiguous = false;
    if (!customerId) {
      const candidates = await db.query(
        `SELECT id FROM customers WHERE wa_id=$1 OR regexp_replace(data->>'whatsapp','[^0-9]','','g') IN ($1,'00'||$1) OR regexp_replace(data->>'phone','[^0-9]','','g') IN ($1,'00'||$1) ORDER BY CASE WHEN wa_id=$1 THEN 0 WHEN regexp_replace(data->>'whatsapp','[^0-9]','','g')=$1 THEN 1 ELSE 2 END,created_at,id`,
        [waId],
      );
      customerId = candidates.rows[0]?.id;
      ambiguous = candidates.rows.length > 1;
    }
    const type = str(message.type) || "unsupported",
      body = object(message[type]),
      text = (type === "text" ? str(body.body) : str(body.caption)).slice(
        0,
        10000,
      ),
      suggestions = extractSuggestions(text);
    if (!customerId) {
      const email = suggestions.find((s) => s.field === "email")?.value,
        company = suggestions.find((s) => s.field === "company")?.value,
        country = suggestions.find((s) => s.field === "country")?.value;
      const match = await db.query(
        `SELECT id FROM customers WHERE ($1<>'' AND lower(data->>'email')=lower($1)) OR ($2<>'' AND $3<>'' AND lower(company)=lower($2) AND lower(data->>'country')=lower($3)) ORDER BY created_at,id`,
        [email || "", company || "", country || ""],
      );
      customerId = match.rows[0]?.id;
      ambiguous = match.rows.length > 1;
    }
    const time = safeMessageTime(message.timestamp),
      settings = await repo.settings(db),
      today = businessDay(settings.timezone),
      policy = await rules(db);
    const activeAdmin = async () => {
      const id = (
        await db.query(
          "SELECT id FROM users WHERE role='admin' AND active ORDER BY created_at LIMIT 1",
        )
      ).rows[0]?.id;
      if (!id) throw new HttpError(409, "没有可接收待分配客户的管理员");
      return id as string;
    };
    let isNew = false;
    if (!customerId) {
      isNew = true;
      customerId = randomUUID();
      const owner = accountRow.active
        ? accountRow.user_id
        : await activeAdmin();
      const data = customerSchema.parse({
        company: "WhatsApp占位校验",
        contact: str(profile.name) || "WhatsApp新客户",
        whatsapp: waId,
        phone: "+" + waId,
        source: "WhatsApp自动录入",
        notes: "WhatsApp自动创建",
      });
      data.company = "";
      await db.query(
        "INSERT INTO customers(id,owner_id,company,grade,stage,data,next_follow_up,wa_id,first_contact_at,last_contact_at,wa_first_receiver_id,wa_received_phone_id,wa_needs_assignment) VALUES($1,$2,'','C','新询盘',$3,$4,$5,$6,$6,$7,$8,$9)",
        [
          customerId,
          owner,
          JSON.stringify(data),
          today,
          waId,
          time,
          accountRow.user_id,
          phoneId,
          !accountRow.active,
        ],
      );
      await assignment(
        db,
        customerId,
        null,
        owner,
        null,
        accountRow.active
          ? "WhatsApp首次消息自动归属"
          : "接收员工已停用，进入管理员待分配池",
      );
    }
    const customer = (
      await db.query(
        "SELECT c.*,u.active AS owner_active FROM customers c JOIN users u ON u.id=c.owner_id WHERE c.id=$1 FOR UPDATE OF c",
        [customerId],
      )
    ).rows[0];
    let conflict =
      !!existingConversation?.conflict ||
      ambiguous ||
      !!customer.deleted_at ||
      (!existingConversation &&
        !isNew &&
        customer.owner_id !== accountRow.user_id);
    let owner = customer.owner_id as string,
      poolRequired = customer.wa_needs_assignment as boolean;
    if (!customer.owner_active || !accountRow.active) {
      poolRequired = true;
      owner = await activeAdmin();
    } else if (
      existingConversation &&
      owner !== accountRow.user_id &&
      !conflict
    ) {
      if (policy.reassignmentPolicy === "number_owner") {
        owner = accountRow.user_id;
        poolRequired = false;
      } else if (policy.reassignmentPolicy === "pool") {
        owner = await activeAdmin();
        poolRequired = true;
      }
    }
    if (owner !== customer.owner_id)
      await assignment(
        db,
        customerId,
        customer.owner_id,
        owner,
        null,
        "按WhatsApp后续入站归属规则调整",
      );
    if (poolRequired) conflict = true;
    await db.query(
      `UPDATE customers SET wa_id=coalesce(wa_id,$2),first_contact_at=LEAST(coalesce(first_contact_at,$3),$3),last_contact_at=GREATEST(coalesce(last_contact_at,$3),$3),wa_first_receiver_id=coalesce(wa_first_receiver_id,$4),wa_received_phone_id=coalesce(wa_received_phone_id,$5),owner_id=$6,wa_needs_assignment=$7,next_follow_up=LEAST(next_follow_up,$8::date),version=version+1,updated_at=now() WHERE id=$1`,
      [
        customerId,
        waId,
        time,
        accountRow.user_id,
        phoneId,
        owner,
        poolRequired,
        today,
      ],
    );
    await db.query(
      "INSERT INTO whatsapp_identities(wa_id,customer_id) VALUES($1,$2) ON CONFLICT(wa_id) DO NOTHING",
      [waId, customerId],
    );
    const conversationId = existingConversation?.id || randomUUID();
    await db.query(
      `INSERT INTO whatsapp_conversations(id,account_id,customer_id,wa_id,first_receiver_id,conflict,conflict_reason,last_inbound_at,first_message_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT(id) DO UPDATE SET first_message_at=LEAST(whatsapp_conversations.first_message_at,EXCLUDED.first_message_at),last_inbound_at=GREATEST(whatsapp_conversations.last_inbound_at,EXCLUDED.last_inbound_at),conflict=EXCLUDED.conflict,conflict_reason=EXCLUDED.conflict_reason`,
      [
        conversationId,
        accountRow.id,
        customerId,
        waId,
        accountRow.user_id,
        conflict,
        conflict ? "疑似跨员工重复、停用员工或已删除客户，待管理员核对" : null,
        time,
      ],
    );
    const localId = randomUUID(),
      mediaId = ["image", "video", "audio", "document", "sticker"].includes(
        type,
      )
        ? str(body.id) || null
        : null;
    const content =
      type === "contacts"
        ? { contacts: array(message.contacts) }
        : type === "location"
          ? { location: body }
          : type === "interactive"
            ? { interactive: body }
            : type === "button"
              ? { button: body }
              : {};
    await db.query(
      `INSERT INTO whatsapp_messages(id,whatsapp_message_id,conversation_id,customer_id,owner_id,account_id,phone_number_id,wa_id,direction,message_type,text_content,media_id,media_mime_type,media_filename,reply_to_message_id,content,message_timestamp,delivery_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'inbound',$9,$10,$11,$12,$13,$14,$15,$16,'received')`,
      [
        localId,
        messageId,
        conversationId,
        customerId,
        owner,
        accountRow.id,
        phoneId,
        waId,
        type,
        text,
        mediaId,
        str(body.mime_type) || null,
        str(body.filename) || null,
        str(object(message.context).id) || null,
        JSON.stringify(content),
        time,
      ],
    );
    if (mediaId)
      await db.query("INSERT INTO whatsapp_media(message_id) VALUES($1)", [
        localId,
      ]);
    await db.query(
      "UPDATE whatsapp_accounts SET last_webhook_at=now(),updated_at=now() WHERE id=$1",
      [accountRow.id],
    );
    if (conflict)
      await alert(
        db,
        "ASSIGNMENT",
        "疑似跨员工重复客户或待分配客户，请管理员核对归属",
        accountRow.id,
        `conflict:${conversationId}`,
      );
    else
      await db.query(
        "INSERT INTO notifications(id,user_id,customer_id,kind,title,event_key) VALUES($1,$2,$3,'whatsapp',$4,$5) ON CONFLICT(event_key) DO NOTHING",
        [
          randomUUID(),
          owner,
          customerId,
          isNew ? "WhatsApp新询盘" : "WhatsApp收到新消息",
          `wa-message:${messageId}`,
        ],
      );
    // 提取出错不得回滚原始消息；只写待确认值，不调用外部AI、不生成虚构资料。
    await db.query("SAVEPOINT whatsapp_suggestions");
    try {
      for (const item of suggestions)
        await db.query(
          "INSERT INTO whatsapp_suggestions(id,customer_id,message_id,field,value,evidence) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(message_id,field,value) DO NOTHING",
          [
            randomUUID(),
            customerId,
            localId,
            item.field,
            item.value,
            item.evidence,
          ],
        );
      await db.query("RELEASE SAVEPOINT whatsapp_suggestions");
    } catch {
      await db.query("ROLLBACK TO SAVEPOINT whatsapp_suggestions");
      await alert(
        db,
        "EXTRACTION",
        "消息已保存，但待确认信息提取失败，请人工核对原文",
        accountRow.id,
        `extraction:${localId}`,
      );
    }
  }
  async function applyStatus(db: Db, status: Json, phoneId: string) {
    const id = str(status.id),
      state = str(status.status);
    if (!id || !["sent", "delivered", "read", "failed"].includes(state)) return;
    const code = String(object(array(status.errors)[0]).code || ""),
      at = safeMessageTime(status.timestamp),
      localId = str(status.biz_opaque_callback_data),
      waId = normalizeNumber(str(status.recipient_id));
    const key = hashToken(
      JSON.stringify([phoneId, id, state, at.toISOString(), code]),
    );
    await db.query(
      "INSERT INTO whatsapp_delivery_events(event_key,phone_number_id,whatsapp_message_id,local_message_id,wa_id,status,event_at,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(event_key) DO NOTHING",
      [
        key,
        phoneId,
        id,
        localId || null,
        waId || null,
        state,
        at,
        code || null,
      ],
    );
    await reconcileStatus(db, phoneId, id, localId);
  }
  async function reconcileStatus(
    db: Db,
    phoneId: string,
    id: string,
    localId = "",
  ) {
    const row = (
      await db.query(
        "SELECT * FROM whatsapp_messages WHERE direction='outbound' AND phone_number_id=$1 AND (whatsapp_message_id=$2 OR (id::text=$3 AND whatsapp_message_id IS NULL)) FOR UPDATE",
        [phoneId, id, localId],
      )
    ).rows[0];
    if (!row) return;
    const events = (
      await db.query(
        "SELECT * FROM whatsapp_delivery_events WHERE phone_number_id=$1 AND whatsapp_message_id=$2 AND (wa_id IS NULL OR wa_id=$3) ORDER BY event_at",
        [phoneId, id, row.wa_id],
      )
    ).rows;
    const rank: Record<string, number> = {
      queued: 0,
      sending: 0,
      unknown: 0,
      failed: 0,
      sent: 1,
      delivered: 2,
      read: 3,
    };
    let current = row.delivery_status as string;
    for (const e of events) {
      if (e.status === "failed" && (rank[current] || 0) >= 2) continue;
      if (e.status !== "failed" && (rank[current] || 0) > (rank[e.status] || 0))
        continue;
      current = e.status;
      await db.query(
        `UPDATE whatsapp_messages SET whatsapp_message_id=coalesce(whatsapp_message_id,$2),delivery_status=$3,sent_at=CASE WHEN $3 IN ('sent','delivered','read') THEN coalesce(sent_at,$4) ELSE sent_at END,delivered_at=CASE WHEN $3 IN ('delivered','read') THEN coalesce(delivered_at,$4) ELSE delivered_at END,read_at=CASE WHEN $3='read' THEN coalesce(read_at,$4) ELSE read_at END,error_code=$5,error_message=$6,locked_at=NULL WHERE id=$1`,
        [
          row.id,
          id,
          e.status,
          e.event_at,
          e.status === "failed" ? e.error_code : null,
          e.status === "failed" ? providerError(e.error_code || "") : null,
        ],
      );
    }
    // HTTP发送响应丢失时，官方回执仍可确认已回复，不能继续误报无人回复。
    if (["sent", "delivered", "read"].includes(current))
      await db.query(
        "UPDATE whatsapp_conversations v SET last_outbound_at=GREATEST(v.last_outbound_at,m.sent_at) FROM whatsapp_messages m WHERE m.id=$1 AND v.id=m.conversation_id",
        [row.id],
      );
  }
  async function processPayload(db: Db, payload: unknown) {
    const root = object(payload);
    if (root.object !== "whatsapp_business_account") return;
    for (const entry of array(root.entry)) {
      const e = object(entry);
      for (const change of array(e.changes)) {
        const c = object(change);
        if (c.field !== "messages") continue;
        const value = object(c.value),
          phoneId = str(object(value.metadata).phone_number_id),
          contacts = array(value.contacts).map(object);
        for (const msg of array(value.messages)) {
          const message = object(msg);
          const contact = contacts.find((x) => x.wa_id === message.from);
          await inbound(
            db,
            phoneId,
            object(contact?.profile),
            message,
            str(e.id),
          );
        }
        for (const status of array(value.statuses))
          await applyStatus(db, object(status), phoneId);
      }
    }
  }
  async function processEvents(limit = 10) {
    let processed = 0;
    for (let i = 0; i < limit; i++) {
      const event = (
        await pool.query(
          `UPDATE whatsapp_webhook_events SET status='processing',locked_at=now(),attempts=attempts+1 WHERE id=(SELECT id FROM whatsapp_webhook_events WHERE ((status IN ('pending','retry') AND available_at<=now()) OR (status='processing' AND locked_at<now()-interval '2 minutes')) ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
        )
      ).rows[0];
      if (!event) break;
      try {
        await transaction(pool, async (db) => {
          await processPayload(
            db,
            JSON.parse(decrypt(event.payload_encrypted, config)),
          );
          await db.query(
            "UPDATE whatsapp_webhook_events SET status='done',processed_at=now(),locked_at=NULL,error_code=NULL,error_message=NULL WHERE id=$1",
            [event.id],
          );
          await db.query(
            "UPDATE whatsapp_alerts SET resolved_at=now() WHERE event_key=$1",
            [`webhook:${event.id}`],
          );
        });
        processed++;
      } catch (error) {
        const status = event.attempts >= 8 ? "failed" : "retry";
        const message =
          error instanceof HttpError
            ? error.message
            : "事件处理失败，已保留并安排重试";
        await pool.query(
          "UPDATE whatsapp_webhook_events SET status=$2,locked_at=NULL,available_at=now()+$3::int*interval '1 second',error_code=$4,error_message=$5 WHERE id=$1",
          [
            event.id,
            status,
            Math.min(3600, 2 ** event.attempts * 5),
            error instanceof HttpError ? String(error.status) : "PROCESSING",
            message,
          ],
        );
        await alert(pool, "WEBHOOK", message, null, `webhook:${event.id}`);
      }
    }
    return processed;
  }
  async function processMedia(limit = 3) {
    await pool.query(
      "UPDATE whatsapp_media SET status='failed',error_message='媒体重试已达上限，请检查连接后手动重试' WHERE status IN ('pending','retry') AND attempts>=5 AND available_at<=now()",
    );
    const rows = (
      await pool.query(
        "UPDATE whatsapp_media SET available_at=now()+interval '2 minutes',attempts=attempts+1 WHERE message_id IN (SELECT message_id FROM whatsapp_media WHERE status IN ('pending','retry') AND available_at<=now() AND attempts<5 ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT $1) RETURNING message_id",
        [limit],
      )
    ).rows;
    for (const row of rows) {
      try {
        const m = (
            await pool.query("SELECT * FROM whatsapp_messages WHERE id=$1", [
              row.message_id,
            ])
          ).rows[0],
          a = await account(pool, m.account_id);
        const media = await graph.media(
          m.media_id,
          m.phone_number_id,
          accountToken(a, config),
        );
        await pool.query(
          "UPDATE whatsapp_media SET content_base64=$2,mime_type=$3,sha256=$4,size_bytes=$5,status='ready',error_message=NULL,updated_at=now() WHERE message_id=$1",
          [
            m.id,
            media.bytes.toString("base64"),
            media.mime,
            hashToken(media.bytes.toString("base64")),
            media.bytes.length,
          ],
        );
      } catch {
        await pool.query(
          "UPDATE whatsapp_media SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry' END,error_message='媒体下载失败或超过25MB，请检查连接后重试',available_at=now()+interval '5 minutes',updated_at=now() WHERE message_id=$1",
          [row.message_id],
        );
      }
    }
  }
  async function processOutbound(limit = 5) {
    // 网络中断/进程崩溃后发送结果可能已被Meta接受，不能自动重发造成重复营销。
    await pool.query(
      "UPDATE whatsapp_messages SET delivery_status='unknown',error_code='UNKNOWN',error_message=$1,locked_at=NULL WHERE direction='outbound' AND delivery_status='sending' AND locked_at<now()-interval '2 minutes'",
      [providerError("UNKNOWN")],
    );
    for (let i = 0; i < limit; i++) {
      const m = (
        await pool.query(
          "UPDATE whatsapp_messages SET delivery_status='sending',locked_at=now(),attempts=attempts+1 WHERE id=(SELECT id FROM whatsapp_messages WHERE direction='outbound' AND delivery_status='queued' AND available_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",
        )
      ).rows[0];
      if (!m) break;
      try {
        const sender = (
          await pool.query("SELECT * FROM users WHERE id=$1 AND active", [
            m.requested_by_id,
          ])
        ).rows[0];
        if (!sender) throw new HttpError(403, "发送员工已停用");
        const v = await conversation(
            pool,
            { id: sender.id, role: sender.role } as User,
            m.conversation_id,
          ),
          a = await account(pool, m.account_id);
        if (
          v.conflict ||
          v.wa_needs_assignment ||
          !a.active ||
          a.connection_status !== "connected" ||
          (sender.role === "sales" && a.user_id !== sender.id)
        )
          throw new HttpError(403, "客户归属、账号状态或发送号码权限已变化");
        if (m.message_type === "text" && !windowOpen(v.last_inbound_at))
          throw new MetaError("131047");
        const body: Json = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: m.wa_id,
          type: m.message_type,
          biz_opaque_callback_data: m.id,
        };
        if (m.message_type === "template") {
          const template = (
            await pool.query(
              "SELECT * FROM whatsapp_templates WHERE account_id=$1 AND template_id=$2",
              [a.id, m.content.templateId],
            )
          ).rows[0];
          if (
            !template ||
            template.status !== "APPROVED" ||
            new Date(template.synced_at).getTime() < Date.now() - 86400000
          )
            throw new HttpError(409, "模板需要重新同步审批状态");
          body.template = m.content.template;
        } else body.text = { body: m.text_content, preview_url: false };
        if (m.reply_to_message_id)
          body.context = { message_id: m.reply_to_message_id };
        const sent = await graph.request<{ messages: { id: string }[] }>(
          `${a.phone_number_id}/messages`,
          accountToken(a, config),
          "POST",
          body,
        );
        const mid = sent.messages?.[0]?.id;
        if (!mid) throw new MetaError("UNKNOWN", true);
        await transaction(pool, async (db) => {
          await db.query(
            "UPDATE whatsapp_messages SET whatsapp_message_id=coalesce(whatsapp_message_id,$2),delivery_status=CASE WHEN delivery_status IN ('delivered','read') THEN delivery_status ELSE 'sent' END,sent_at=coalesce(sent_at,now()),locked_at=NULL,error_code=NULL,error_message=NULL WHERE id=$1",
            [m.id, mid],
          );
          await db.query(
            "UPDATE whatsapp_conversations SET last_outbound_at=now() WHERE id=$1",
            [m.conversation_id],
          );
          await reconcileStatus(db, a.phone_number_id, mid, m.id);
        });
      } catch (error) {
        const code =
            error instanceof MetaError
              ? error.code
              : error instanceof HttpError
                ? String(error.status)
                : "UNKNOWN",
          uncertain =
            error instanceof MetaError
              ? error.uncertain
              : !(error instanceof HttpError);
        const retry = code === "429" && m.attempts < 5;
        const state = uncertain ? "unknown" : retry ? "queued" : "failed";
        await pool.query(
          "UPDATE whatsapp_messages SET delivery_status=$2,error_code=$3,error_message=$4,locked_at=NULL,available_at=now()+interval '1 minute' WHERE id=$1 AND delivery_status NOT IN ('delivered','read')",
          [
            m.id,
            state,
            code,
            error instanceof HttpError
              ? error.message
              : providerError("UNKNOWN"),
          ],
        );
        if (["190", "10", "200"].includes(code))
          await connectionError(pool, await account(pool, m.account_id), error);
      }
    }
  }
  async function reminders() {
    const configRules = await rules(pool);
    for (const minutes of configRules.reminderMinutes) {
      await pool.query(
        `INSERT INTO notifications(id,user_id,customer_id,kind,title,event_key) SELECT gen_random_uuid(),c.owner_id,c.id,'whatsapp_timeout',$1,'wa-unanswered:'||first.id::text||':'||$2::text FROM whatsapp_conversations v JOIN customers c ON c.id=v.customer_id JOIN users u ON u.id=c.owner_id CROSS JOIN LATERAL(SELECT m.id,m.message_timestamp FROM whatsapp_messages m WHERE m.conversation_id=v.id AND m.direction='inbound' AND m.message_timestamp>coalesce(v.last_outbound_at,'epoch') ORDER BY m.message_timestamp,m.id LIMIT 1) first WHERE NOT v.conflict AND NOT c.wa_needs_assignment AND c.deleted_at IS NULL AND u.active AND first.message_timestamp<=now()-$2::int*interval '1 minute' ON CONFLICT(event_key) DO NOTHING`,
        [`WhatsApp消息超过${minutes}分钟未回复`, minutes],
      );
    }
  }
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      await processEvents();
      await processOutbound();
      await processMedia();
      await reminders();
    } finally {
      running = false;
    }
  }
  return {
    pool,
    config,
    graph,
    processEvents,
    processOutbound,
    processMedia,
    reminders,
    tick,
    processPayload,
  };
}
export type WhatsAppService = ReturnType<typeof createWhatsAppService>;
export function templateView(row: Record<string, unknown>): WaTemplate {
  const components = array(row.components).map(object);
  const bodies = components.filter((c) => c.type === "BODY");
  const text = bodies.map((c) => str(c.text)).join("");
  const placeholders = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) =>
    Number(m[1]),
  );
  const count = Math.max(0, ...placeholders);
  const supported =
    !/\{\{[^\d}]/.test(text) &&
    components.every(
      (c) =>
        c.type === "BODY" ||
        c.type === "FOOTER" ||
        (c.type === "HEADER" &&
          c.format === "TEXT" &&
          !str(c.text).includes("{{")),
    );
  return {
    id: String(row.template_id),
    accountId: String(row.account_id),
    name: String(row.name),
    language: String(row.language),
    status: String(row.status),
    category: String(row.category),
    components,
    parameterCount: count,
    supported,
  };
}
