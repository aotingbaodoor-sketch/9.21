import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import { addDays, businessDay, HttpError, toCustomer } from "./domain.ts";
import type { CustomerInput, Settings, User } from "../shared/contracts.ts";

export async function settings(db: Db): Promise<Settings> {
  const {
    rows: [r],
  } = await db.query("SELECT data,version FROM settings WHERE id=1");
  return { ...r.data, version: r.version };
}
export async function audit(
  db: Db,
  actor: User | null,
  action: string,
  entity: string,
  details: unknown = {},
) {
  await db.query(
    "INSERT INTO audit_logs(id,user_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), actor?.id ?? null, action, entity, JSON.stringify(details)],
  );
}
export const scope = (user: User, alias = "c", index = 1) =>
  user.role === "admin"
    ? { sql: "TRUE", params: [] }
    : {
        sql: `${alias}.owner_id=$${index} AND NOT ${alias}.wa_needs_assignment`,
        params: [user.id],
      };
export function filters(
  user: User,
  query: Record<string, unknown>,
  offset = 1,
) {
  const s = scope(user, "c", offset),
    params: unknown[] = [...s.params],
    parts = [s.sql];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    parts.push(sql.replace("?", `$${offset + params.length - 1}`));
  };
  if (query.deleted === "true") {
    if (user.role !== "admin") throw new HttpError(403, "无权访问回收站");
    parts.push("c.deleted_at IS NOT NULL");
  } else parts.push("c.deleted_at IS NULL");
  const q = typeof query.q === "string" ? query.q.slice(0, 200).trim() : "";
  if (q)
    add(
      "(c.company || ' ' || c.data::text) ILIKE ?",
      `%${q.replace(/[\\%_]/g, "\\$&")}%`,
    );
  for (const [key, sql] of Object.entries({
    grade: "c.grade=?",
    stage: "c.stage=?",
    country: "c.data->>'country'=?",
    source: "c.data->>'source'=?",
    tag: "c.data->'tags' ? ?",
  })) {
    if (typeof query[key] === "string" && query[key]) {
      if (key === "tag") {
        params.push(query[key]);
        parts.push(`c.data->'tags' ? $${offset + params.length - 1}`);
      } else add(sql, query[key]);
    }
  }
  if (typeof query.owner === "string" && query.owner) {
    if (user.role !== "admin" && query.owner !== user.id)
      throw new HttpError(403, "无权筛选其他销售");
    add("c.owner_id::text=?", query.owner);
  }
  return { params, parts };
}
export async function customer(
  db: Db,
  user: User,
  id: string,
  lock = false,
  includeDeleted = false,
) {
  const s = scope(user, "c", 2);
  const result = await db.query(
    `SELECT c.*,u.name AS owner FROM customers c JOIN users u ON u.id=c.owner_id WHERE c.id::text=$1 AND ${s.sql} ${includeDeleted ? "" : "AND c.deleted_at IS NULL"} ${lock ? "FOR UPDATE OF c" : ""}`,
    [id, ...s.params],
  );
  if (!result.rowCount) throw new HttpError(404, "客户不存在或无权访问");
  return result.rows[0];
}
export function checkVersion(
  row: { version: number },
  version: number | undefined,
) {
  if (!version || row.version !== version)
    throw new HttpError(
      409,
      "该记录已被其他人修改，请重新加载最新资料后再保存",
      { conflict: true },
    );
}
export async function activeOwner(db: Db, id: string) {
  const r = await db.query("SELECT id FROM users WHERE id=$1 AND active=true", [
    id,
  ]);
  if (!r.rowCount) throw new HttpError(400, "请选择有效的客户负责人");
}
export async function duplicates(
  db: Db,
  user: User,
  data: CustomerInput,
  except = "",
) {
  const s = scope(user, "c", 7);
  return (
    await db.query(
      `SELECT c.id,c.company,c.owner_id FROM customers c WHERE c.deleted_at IS NULL AND c.id::text<>$1 AND ${s.sql} AND (($2<>'' AND lower(c.company)=lower($2)) OR ($3<>'' AND lower(c.data->>'email')=lower($3)) OR ($4<>'' AND regexp_replace(c.data->>'phone','[^0-9]','','g')=$4) OR ($5<>'' AND regexp_replace(c.data->>'whatsapp','[^0-9]','','g')=$5) OR ($6<>'' AND lower(c.data->>'website')=lower($6)))`,
      [
        except,
        data.company,
        data.email,
        data.phone.replace(/\D/g, ""),
        data.whatsapp.replace(/\D/g, ""),
        data.website,
        ...s.params,
      ],
    )
  ).rows;
}
export async function notifyAssignment(db: Db, id: string, owner: string) {
  await db.query(
    "INSERT INTO notifications(id,user_id,customer_id,kind,title,event_key) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), owner, id, "assignment", "分配了新客户", randomUUID()],
  );
}
export async function createCustomer(db: Db, user: User, input: CustomerInput) {
  if (!input.company.trim()) throw new HttpError(400, "公司名称必填");
  if (user.role === "sales" && input.ownerId && input.ownerId !== user.id)
    throw new HttpError(403, "销售不能指定其他负责人");
  const owner = input.ownerId || user.id;
  await activeOwner(db, owner);
  // 串行化重复检测和新建，避免同时提交绕过提示。
  await db.query("SELECT pg_advisory_xact_lock(825115)");
  const dup = await duplicates(db, user, input);
  if (dup.length && !input.allowDuplicate)
    throw new HttpError(409, "发现疑似重复客户，请核对后再继续", {
      duplicates: dup,
    });
  const config = await settings(db),
    next =
      input.next ||
      addDays(businessDay(config.timezone), config.cycles[input.grade]),
    id = randomUUID();
  const {
    version: _v,
    allowDuplicate: _d,
    ownerId: _o,
    next: _n,
    ...data
  } = input;
  await db.query(
    "INSERT INTO customers(id,owner_id,company,grade,stage,data,next_follow_up,won_at) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $5='已成交' THEN now() ELSE NULL END)",
    [
      id,
      owner,
      input.company,
      input.grade,
      input.stage,
      JSON.stringify(data),
      next,
    ],
  );
  await notifyAssignment(db, id, owner);
  await audit(db, user, "新增客户", id, { company: input.company });
  return toCustomer(await customer(db, user, id), config);
}
export async function listCustomers(
  db: Db,
  user: User,
  query: Record<string, unknown>,
) {
  const config = await settings(db),
    today = businessDay(config.timezone),
    { parts, params } = filters(user, query);
  params.push(today);
  const date = `$${params.length}`;
  if (query.status === "已逾期") parts.push(`c.next_follow_up<${date}::date`);
  if (query.status === "今日跟进") parts.push(`c.next_follow_up=${date}::date`);
  if (query.status === "即将跟进")
    parts.push(
      `c.next_follow_up>${date}::date AND c.next_follow_up<=${date}::date+3`,
    );
  params.push(config.timezone);
  const zone = `$${params.length}`;
  const completed = `EXISTS(SELECT 1 FROM follow_up_records f WHERE f.customer_id=c.id AND (f.follow_up_at AT TIME ZONE ${zone})::date=${date}::date)`;
  if (query.status === "今日已完成") parts.push(completed);
  const page = Math.max(1, Math.min(100000, Number(query.page) || 1)),
    limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
  // SQL中保留日期/时区参数类型，即使当前筛选没使用它们。
  parts.push(`${date}::date IS NOT NULL`, `${zone}::text IS NOT NULL`);
  const where = parts.join(" AND "),
    count = await db.query(
      `SELECT count(*)::int AS total FROM customers c WHERE ${where}`,
      params,
    );
  const result = await db.query(
    `SELECT c.*,u.name AS owner,${completed} AS completed_today,
    (SELECT count(*)::int FROM whatsapp_messages m JOIN whatsapp_conversations v ON v.id=m.conversation_id LEFT JOIN whatsapp_reads r ON r.conversation_id=v.id AND r.user_id=$${params.length + 3} WHERE m.customer_id=c.id AND m.direction='inbound' ${user.role === "sales" ? "AND NOT v.conflict" : ""} AND m.created_at>coalesce(r.read_at,'epoch')) AS whatsapp_unread,
    (SELECT m.text_content FROM whatsapp_messages m JOIN whatsapp_conversations v ON v.id=m.conversation_id WHERE m.customer_id=c.id ${user.role === "sales" ? "AND NOT v.conflict" : ""} ORDER BY m.message_timestamp DESC,m.id DESC LIMIT 1) AS whatsapp_last_message
    FROM customers c JOIN users u ON c.owner_id=u.id WHERE ${where} ORDER BY CASE WHEN c.grade='A' AND c.next_follow_up<${date}::date THEN 0 WHEN c.grade='A' AND c.next_follow_up=${date}::date THEN 1 WHEN c.grade='B' AND c.next_follow_up<${date}::date THEN 2 WHEN c.grade='B' AND c.next_follow_up=${date}::date THEN 3 WHEN c.grade='C' THEN 4 WHEN c.grade='D' THEN 5 ELSE 6 END,c.next_follow_up,c.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, (page - 1) * limit, user.id],
  );
  return {
    items: result.rows.map((r) => toCustomer(r, config)),
    total: count.rows[0].total,
    page,
    pages: Math.max(1, Math.ceil(count.rows[0].total / limit)),
  };
}
export async function records(
  db: Db,
  user: User,
  query: Record<string, unknown>,
) {
  const s = scope(user, "c"),
    p: unknown[] = [...s.params],
    parts = [s.sql, "c.deleted_at IS NULL"];
  const add = (sql: string, v: unknown) => {
    p.push(v);
    parts.push(sql.replace("?", `$${p.length}`));
  };
  if (user.role === "sales") add("f.user_id=?", user.id);
  if (query.customerId) add("c.id::text=?", query.customerId);
  if (query.userId && user.role === "admin")
    add("f.user_id::text=?", query.userId);
  if (query.q)
    add(
      "(c.company || ' ' || f.content || ' ' || f.response || ' ' || f.plan) ILIKE ?",
      `%${String(query.q)
        .slice(0, 200)
        .replace(/[\\%_]/g, "\\$&")}%`,
    );
  const config = await settings(db);
  p.push(config.timezone);
  const zone = `$${p.length}`;
  parts.push(`${zone}::text IS NOT NULL`);
  if (query.from)
    add(`(f.follow_up_at AT TIME ZONE ${zone})::date >= ?::date`, query.from);
  if (query.to)
    add(`(f.follow_up_at AT TIME ZONE ${zone})::date <= ?::date`, query.to);
  const page = Math.max(1, Number(query.page) || 1),
    limit = 20;
  const from = `FROM follow_up_records f JOIN customers c ON c.id=f.customer_id JOIN users u ON u.id=f.user_id WHERE ${parts.join(" AND ")}`;
  const total = (await db.query(`SELECT count(*)::int AS total ${from}`, p))
    .rows[0].total;
  const result = await db.query(
    `SELECT f.id,c.id AS "customerId",c.company,u.name AS "user",u.id AS "userId",f.method,f.content,f.response,f.plan,f.follow_up_at AS date,f.next_follow_up AS next ${from} ORDER BY f.follow_up_at DESC,f.id LIMIT $${p.length + 1} OFFSET $${p.length + 2}`,
    [...p, limit, (page - 1) * limit],
  );
  return {
    items: result.rows,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}
export async function refreshNotifications(db: Db) {
  const config = await settings(db),
    today = businessDay(config.timezone);
  await db.query(
    `INSERT INTO notifications(id,user_id,customer_id,kind,title,event_key,due_date)
 SELECT gen_random_uuid(),c.owner_id,c.id,'due',CASE WHEN c.next_follow_up<$1::date THEN '客户已逾期' WHEN c.next_follow_up=$1::date THEN '客户今日待跟进' ELSE '客户明日待跟进' END,
 c.id::text || ':' || c.owner_id::text || ':' || c.next_follow_up::text || ':' || $1::text,c.next_follow_up
 FROM customers c WHERE c.deleted_at IS NULL AND c.next_follow_up<=$1::date+1 ON CONFLICT(event_key) DO NOTHING`,
    [today],
  );
}
