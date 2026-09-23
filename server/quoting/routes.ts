import type { Express, Request, Response } from "express";
import type pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { freightSchema, productSchema, quotationSettingsSchema, quoteInputSchema, lineSchema } from "../../shared/quoting.ts";
import type { Calculation, Freight, Product, QuoteInput } from "../../shared/quoting.ts";
import type { User } from "../../shared/contracts.ts";
import type { Db } from "../db.ts";
import { transaction } from "../db.ts";
import { HttpError, requireAdmin, businessDay } from "../domain.ts";
import * as repo from "../repository.ts";
import { calculate, policy, publicCalculation } from "./engine.ts";
import { renderQuotePdf } from "./pdf.ts";
import { importLines } from "./spreadsheet.ts";
import type { QuoteRow } from "./types.ts";

type Mutate = (req: Request, res: Response, run: (db: pg.PoolClient) => Promise<unknown>) => Promise<void>;
type Project = { id: string; customer_id: string; name: string; version: number; company: string; owner_id: string };
const id = (r: Request, key = "id") => z.uuid().parse(r.params[key]);
const sales = (u: User) => { if (!["admin", "sales"].includes(u.role)) throw new HttpError(403, "仅管理员和销售可以操作报价"); };
const logistics = (u: User) => { if (!["admin", "logistics"].includes(u.role)) throw new HttpError(403, "仅管理员和物流可维护运价"); };
export async function getQuoteSettings(db: Db) {
  const r = (await db.query("SELECT * FROM quotation_settings WHERE id=1")).rows[0];
  return { data: quotationSettingsSchema.parse(r.data), version: r.version as number };
}
async function project(db: Db, actor: User, projectId: string, lock = false): Promise<Project> {
  sales(actor);
  const r = (await db.query(`SELECT p.*,c.company,c.owner_id FROM quotation_projects p JOIN customers c ON c.id=p.customer_id WHERE p.id=$1 AND c.deleted_at IS NULL AND ($2='admin' OR (c.owner_id=$3 AND NOT c.wa_needs_assignment)) ${lock ? "FOR UPDATE OF p,c" : ""}`, [projectId, actor.role, actor.id])).rows[0];
  if (!r) throw new HttpError(404, "项目不存在或无权访问"); return r;
}
async function quote(db: Db, actor: User, quoteId: string, lock = false) {
  const q = (await db.query("SELECT * FROM quotation_versions WHERE id=$1", [quoteId])).rows[0] as QuoteRow | undefined;
  if (!q) throw new HttpError(404, "报价不存在");
  const p = await project(db, actor, q.project_id, lock);
  // Project lock serializes version creation, workflow actions, PDF commits and customer reassignment.
  const current = lock ? (await db.query("SELECT * FROM quotation_versions WHERE id=$1 FOR UPDATE", [quoteId])).rows[0] as QuoteRow : q;
  return { q: current, p };
}
async function compute(db: Db, actor: User, p: Project, input: QuoteInput) {
  // A transaction owns one client: finish each query before starting the next.
  // Keep these reads on that client rather than escaping the transaction via the pool.
  const { data: settings } = await getQuoteSettings(db);
  const products = await db.query("SELECT id,data,version FROM quotation_products WHERE id=ANY($1::uuid[])", [input.lines.map(l => l.productId)]);
  const rates = input.freightId
    ? await db.query("SELECT id,data,version FROM quotation_freight WHERE id=$1", [input.freightId])
    : { rows: [] };
  const crm = await repo.settings(db);
  const c = calculate(input, products.rows.map(r => ({ ...r.data, id: r.id, version: r.version })) as Product[], rates.rows[0] ? { ...rates.rows[0].data, id: rates.rows[0].id, version: rates.rows[0].version } as Freight : null, settings, policy(settings, actor), businessDay(crm.timezone), p.id);
  return c;
}
async function task(db: Db, actor: User, taskId: string, lock = false) {
  if (lock) await db.query("SELECT v.id FROM quotation_versions v JOIN quotation_reviews t ON t.quote_id=v.id WHERE t.id=$1 FOR UPDATE OF v", [taskId]);
  const r = (await db.query(`SELECT t.*,v.input,v.snapshot,v.project_id,v.status AS quote_status FROM quotation_reviews t JOIN quotation_versions v ON v.id=t.quote_id JOIN quotation_projects p ON p.id=v.project_id JOIN customers c ON c.id=p.customer_id WHERE t.id=$1 AND c.deleted_at IS NULL AND ($2='admin' OR (t.assigned_to=$3 AND (t.discipline=$2 OR (t.discipline='production' AND $2='technical')))) ${lock ? "FOR UPDATE OF t" : ""}`, [taskId, actor.role, actor.id])).rows[0];
  if (!r) throw new HttpError(404, "任务不存在或未分配给您"); return r;
}
async function fileAccess(db: Db, actor: User, projectId: string, taskId?: string) {
  if (["admin", "sales"].includes(actor.role)) return project(db, actor, projectId);
  if (!taskId) throw new HttpError(403, "需要已分配的任务");
  const t = await task(db, actor, taskId); if (t.project_id !== projectId) throw new HttpError(404, "附件不属于该任务");
}
function productView(p: Product) {
  const { prices: _prices, formula: _formula, bands: _bands, packing, options, ...publicData } = p;
  const { costPerPackage: _cost, kgPerSqm: _kg, fixedKg: _fixed, tareKg: _tare, ...packingPublic } = packing;
  return { ...publicData, packing: packingPublic, options: options.map(({ cost: _optionCost, ...o }) => o) };
}
export function registerQuoting(app: Express, pool: pg.Pool, mutate: Mutate) {
  app.get("/api/quoting/settings", async (req, res) => {
    const s = await getQuoteSettings(pool);
    res.json(req.actor.role === "admin" ? s : { configured: s.data.configured, currencies: ["CNY", ...Object.keys(s.data.fx)], policy: policy(s.data, req.actor) });
  });
  app.put("/api/quoting/settings", async (req, res) => mutate(req, res, async db => {
    requireAdmin(req.actor); const input = quotationSettingsSchema.parse(req.body.data);
    const r = await db.query("UPDATE quotation_settings SET data=$1,version=version+1 WHERE id=1 AND version=$2 RETURNING version", [JSON.stringify(input), z.number().int().parse(req.body.version)]);
    if (!r.rowCount) throw new HttpError(409, "设置已被修改，请刷新后重试"); await repo.audit(db, req.actor, "更新报价规则", "quotation_settings"); return r.rows[0];
  }));
  app.get("/api/quoting/products", async (req, res) => {
    sales(req.actor); const s = await getQuoteSettings(pool), canCost = req.actor.role === "admin" || policy(s.data, req.actor).viewCosts;
    const rows = (await pool.query("SELECT * FROM quotation_products WHERE ($1='admin' OR (data->>'active')::boolean) ORDER BY sku LIMIT 2000", [req.actor.role])).rows.map(r => ({ ...r.data, id: r.id, version: r.version }) as Product);
    res.json(rows.map(p => canCost ? p : productView(p)));
  });
  app.post("/api/quoting/products", async (req, res) => mutate(req, res, async db => {
    requireAdmin(req.actor); const p = productSchema.parse(req.body), productId = randomUUID();
    await db.query("INSERT INTO quotation_products(id,sku,data) VALUES($1,$2,$3)", [productId, p.sku, JSON.stringify(p)]); await repo.audit(db, req.actor, "新增报价产品", productId); return { id: productId, version: 1 };
  }));
  app.put("/api/quoting/products/:id", async (req, res) => mutate(req, res, async db => {
    requireAdmin(req.actor); const p = productSchema.parse(req.body);
    const r = await db.query("UPDATE quotation_products SET sku=$1,data=$2,version=version+1,updated_at=now() WHERE id=$3 AND version=$4 RETURNING id,version", [p.sku, JSON.stringify(p), id(req), z.number().int().parse(req.body.version)]);
    if (!r.rowCount) throw new HttpError(409, "产品已被修改，请刷新"); await repo.audit(db, req.actor, "修改报价产品", id(req)); return r.rows[0];
  }));
  app.get("/api/quoting/freight", async (req, res) => {
    if (req.actor.role === "technical") throw new HttpError(403, "无运价权限");
    const s = await getQuoteSettings(pool), canCost = req.actor.role === "admin" || req.actor.role === "logistics" || policy(s.data, req.actor).viewFreightCost;
    if (req.query.project) await project(pool, req.actor, z.uuid().parse(req.query.project));
    const rows = (await pool.query("SELECT * FROM quotation_freight f WHERE ($1='admin' OR ((data->>'active')::boolean AND ((data->>'projectId') IS NULL OR data->>'projectId'=$2 OR ($1='logistics' AND EXISTS(SELECT 1 FROM quotation_reviews t JOIN quotation_versions v ON v.id=t.quote_id WHERE t.assigned_to=$3 AND t.discipline='logistics' AND v.project_id::text=f.data->>'projectId'))))) ORDER BY updated_at DESC LIMIT 2000", [req.actor.role, req.query.project || "", req.actor.id])).rows;
    res.json(rows.map(r => canCost ? { ...r.data, id: r.id, version: r.version } : { id: r.id, version: r.version, name: r.data.name, country: r.data.country, city: r.data.city, originPort: r.data.originPort, destinationPort: r.data.destinationPort, mode: r.data.mode, validFrom: r.data.validFrom, validUntil: r.data.validUntil, projectId: r.data.projectId }));
  });
  for (const method of ["post", "put"] as const) app[method](`/api/quoting/freight${method === "put" ? "/:id" : ""}`, async (req, res) => mutate(req, res, async db => {
    logistics(req.actor); const f = freightSchema.parse(req.body), rateId = method === "post" ? randomUUID() : id(req);
    if (f.projectId) { if (req.actor.role === "admin") await project(db, req.actor, f.projectId); else { const tasks = await db.query("SELECT 1 FROM quotation_reviews t JOIN quotation_versions v ON v.id=t.quote_id WHERE t.assigned_to=$1 AND t.discipline='logistics' AND v.project_id=$2", [req.actor.id, f.projectId]); if (!tasks.rowCount) throw new HttpError(403, "项目运价需要已分配的物流任务"); } }
    if (method === "post") await db.query("INSERT INTO quotation_freight(id,data) VALUES($1,$2)", [rateId, JSON.stringify(f)]);
    else if (!(await db.query("UPDATE quotation_freight SET data=$1,version=version+1,updated_at=now() WHERE id=$2 AND version=$3", [JSON.stringify(f), rateId, z.number().int().parse(req.body.version)])).rowCount) throw new HttpError(409, "运价已更新，请刷新");
    await repo.audit(db, req.actor, "维护报价运价", rateId); return { id: rateId };
  }));
  app.get("/api/quoting/projects", async (req, res) => {
    sales(req.actor); const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1)), search = String(req.query.q || "").slice(0, 100);
    const params = [req.actor.role, req.actor.id, `%${search.replace(/[\\%_]/g, "\\$&")}%`];
    const where = "FROM quotation_projects p JOIN customers c ON c.id=p.customer_id WHERE c.deleted_at IS NULL AND ($1='admin' OR (c.owner_id=$2 AND NOT c.wa_needs_assignment)) AND (p.name ILIKE $3 OR c.company ILIKE $3)";
    const [count, rows] = await Promise.all([pool.query(`SELECT count(*) ${where}`, params), pool.query(`SELECT p.*,c.company,(SELECT status FROM quotation_versions WHERE project_id=p.id ORDER BY number DESC LIMIT 1) status ${where} ORDER BY p.created_at DESC LIMIT 20 OFFSET $4`, [...params, (page - 1) * 20])]);
    res.json({ items: rows.rows, total: Number(count.rows[0].count), page });
  });
  app.post("/api/quoting/projects", async (req, res) => mutate(req, res, async db => {
    sales(req.actor); const input = z.object({ customerId: z.uuid(), name: z.string().trim().min(1).max(150) }).parse(req.body);
    await repo.customer(db, req.actor, input.customerId, true); const projectId = randomUUID();
    await db.query("INSERT INTO quotation_projects(id,customer_id,name,created_by) VALUES($1,$2,$3,$4)", [projectId, input.customerId, input.name, req.actor.id]); await repo.audit(db, req.actor, "创建报价项目", projectId); return { id: projectId };
  }));
  app.get("/api/quoting/projects/:id", async (req, res) => {
    const p = await project(pool, req.actor, id(req));
    const [versions, files, order] = await Promise.all([pool.query("SELECT id,number,status,version,reason,previous_total,snapshot->>'total' total,input->>'currency' currency,created_at,created_by FROM quotation_versions WHERE project_id=$1 ORDER BY number DESC", [p.id]), pool.query("SELECT id,name,mime,kind,created_at FROM quotation_files WHERE project_id=$1 ORDER BY created_at DESC", [p.id]), pool.query("SELECT id,quote_id,created_at FROM quotation_orders WHERE project_id=$1", [p.id])]);
    res.json({ project: p, versions: versions.rows, files: files.rows, order: order.rows[0] || null });
  });
  app.post("/api/quoting/projects/:id/preview", async (req, res) => {
    const p = await project(pool, req.actor, id(req)), input = quoteInputSchema.parse(req.body), c = await compute(pool, req.actor, p, input);
    res.json(publicCalculation(c, policy((await getQuoteSettings(pool)).data, req.actor)));
  });
  app.post("/api/quoting/projects/:id/versions", async (req, res) => mutate(req, res, async db => {
    const p = await project(db, req.actor, id(req), true); repo.checkVersion(p, req.body.baseVersion);
    if ((await db.query("SELECT 1 FROM quotation_orders WHERE project_id=$1", [p.id])).rowCount) throw new HttpError(409, "已转订单的项目不能修改，请新建项目记录变更订单");
    const input = quoteInputSchema.parse(req.body.input), reason = z.string().trim().min(1).max(1000).parse(req.body.reason), c = await compute(db, req.actor, p, input), customer = await repo.customer(db, req.actor, p.customer_id);
    const prior = (await db.query("SELECT number,snapshot->>'total' total FROM quotation_versions WHERE project_id=$1 ORDER BY number DESC LIMIT 1", [p.id])).rows[0], quoteId = randomUUID();
    await db.query("INSERT INTO quotation_versions(id,project_id,number,input,snapshot,customer_snapshot,reason,previous_total,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [quoteId, p.id, (prior?.number || 0) + 1, JSON.stringify(input), JSON.stringify(c), JSON.stringify({ company: customer.company, contact: customer.data.contact || "", email: customer.data.email || "", country: customer.data.country || "" }), reason, prior?.total || null, req.actor.id]);
    await db.query("UPDATE quotation_projects SET version=version+1,name=$2 WHERE id=$1", [p.id, input.name]); await repo.audit(db, req.actor, "创建报价版本", quoteId, { number: (prior?.number || 0) + 1, previousTotal: prior?.total, total: c.total, reason }); return { id: quoteId };
  }));
  app.get("/api/quoting/versions/:id", async (req, res) => {
    const { q } = await quote(pool, req.actor, id(req)), settings = (await getQuoteSettings(pool)).data;
    const [reviews, documents] = await Promise.all([pool.query("SELECT id,discipline,assigned_to,status,comment,file_id,version FROM quotation_reviews WHERE quote_id=$1", [q.id]), pool.query("SELECT id,kind,language,sha256,created_at FROM quotation_documents WHERE quote_id=$1", [q.id])]);
    res.json({ ...q, snapshot: publicCalculation(q.snapshot, policy(settings, req.actor)), reviews: reviews.rows, documents: documents.rows });
  });
  app.post("/api/quoting/versions/:id/submit", async (req, res) => mutate(req, res, async db => {
    const { q } = await quote(db, req.actor, id(req), true); repo.checkVersion(q, req.body.version);
    if (q.status !== "draft") throw new HttpError(409, "只可提交草稿版本");
    const disciplines = [...new Set(q.snapshot.issues.map(i => i.discipline))];
    for (const discipline of disciplines) await db.query("INSERT INTO quotation_reviews(id,quote_id,discipline) VALUES($1,$2,$3)", [randomUUID(), q.id, discipline]);
    await db.query("UPDATE quotation_versions SET status=$2,version=version+1 WHERE id=$1", [q.id, disciplines.length ? "submitted" : "approved"]); await repo.audit(db, req.actor, "提交报价审核", q.id); return { id: q.id };
  }));
  app.get("/api/quoting/tasks", async (req, res) => {
    if (req.actor.role === "sales") throw new HttpError(403, "无审批任务权限");
    const rows = (await pool.query("SELECT t.*,v.project_id,v.number,v.input->>'name' name FROM quotation_reviews t JOIN quotation_versions v ON v.id=t.quote_id JOIN quotation_projects p ON p.id=v.project_id JOIN customers c ON c.id=p.customer_id WHERE c.deleted_at IS NULL AND ($1='admin' OR (t.assigned_to=$2 AND (t.discipline=$1 OR (t.discipline='production' AND $1='technical')))) ORDER BY v.created_at DESC LIMIT 500", [req.actor.role, req.actor.id])).rows; res.json(rows);
  });
  app.get("/api/quoting/tasks/:id", async (req, res) => {
    const t = await task(pool, req.actor, id(req));
    const { snapshot, input, ...rest } = t as { snapshot: Calculation; input: QuoteInput; [k: string]: unknown };
    const tech = req.actor.role === "technical";
    const files = (await pool.query("SELECT id,name,mime,kind FROM quotation_files WHERE project_id=$1 AND kind IN ('reference','technical')", [t.project_id])).rows;
    res.json({ ...rest, input: { name: input.name, country: input.country, city: input.city, projectAddress: input.projectAddress, deliveryAddress: input.deliveryAddress, originPort: input.originPort, destinationPort: input.destinationPort, freightMode: input.freightMode, incoterm: input.incoterm, targetDate: input.targetDate, lines: input.lines.map(({ unitPrice: _price, discountPct: _discount, ...l }) => l) }, issues: snapshot.issues, lines: snapshot.lines.map(l => ({ key: l.key, sku: l.sku, nameZh: l.nameZh, svg: l.svg, widthMm: l.widthMm, heightMm: l.heightMm, quantity: l.quantity, specs: l.specs, options: l.options, special: l.special, packed: l.packed })), packing: { packages: snapshot.packages, cbm: snapshot.cbm, grossKg: snapshot.grossKg, containers: snapshot.containers }, ...(!tech && req.actor.role === "logistics" ? { freight: snapshot.private.freight } : {}), files });
  });
  app.post("/api/quoting/tasks/:id/assign", async (req, res) => mutate(req, res, async db => {
    requireAdmin(req.actor); const t = await task(db, req.actor, id(req), true); repo.checkVersion(t, req.body.version);
    const userId = z.uuid().parse(req.body.userId), employee = (await db.query("SELECT role FROM users WHERE id=$1 AND active", [userId])).rows[0];
    if (!employee || ![t.discipline === "production" ? "technical" : t.discipline, "admin"].includes(employee.role)) throw new HttpError(400, "员工角色不适合该任务");
    if (t.status !== "pending") throw new HttpError(409, "已处理任务不能重新分配");
    await db.query("UPDATE quotation_reviews SET assigned_to=$2,version=version+1 WHERE id=$1", [t.id, userId]); await repo.audit(db, req.actor, "分配报价任务", t.id, { userId }); return { id: t.id };
  }));
  app.post("/api/quoting/tasks/:id/review", async (req, res) => mutate(req, res, async db => {
    const t = await task(db, req.actor, id(req), true); repo.checkVersion(t, req.body.version);
    const input = z.object({ status: z.enum(["approved", "rejected"]), comment: z.string().trim().min(1).max(2000), fileId: z.uuid().nullable().default(null) }).parse(req.body);
    if (t.status !== "pending" || (t.discipline !== "production" && t.quote_status !== "submitted")) throw new HttpError(409, "任务已处理或报价状态已变化");
    if (input.fileId && !(await db.query("SELECT 1 FROM quotation_files WHERE id=$1 AND project_id=$2", [input.fileId, t.project_id])).rowCount) throw new HttpError(404, "附件不属于此项目");
    if (input.status === "approved" && t.discipline !== "production" && (t.snapshot as Calculation).issues.some(i => i.hard && i.discipline === t.discipline)) throw new HttpError(422, "数据缺失/失效不能用审批跳过。请维护规则后新建报价版本");
    if (input.status === "approved" && ["technical", "production"].includes(t.discipline)) {
      const f = input.fileId && (await db.query("SELECT 1 FROM quotation_files WHERE id=$1 AND project_id=$2 AND kind='technical'", [input.fileId, t.project_id])).rowCount;
      if (!f) throw new HttpError(422, "技术审核必须附上本项目已核实图纸");
    }
    await db.query("UPDATE quotation_reviews SET status=$2,comment=$3,file_id=$4,reviewed_by=$5,reviewed_at=now(),version=version+1 WHERE id=$1", [t.id, input.status, input.comment, input.fileId, req.actor.id]);
    if (t.discipline !== "production") {
      const pending = await db.query("SELECT 1 FROM quotation_reviews WHERE quote_id=$1 AND status<>'approved' AND discipline<>'production'", [t.quote_id]);
      await db.query("UPDATE quotation_versions SET status=$2,version=version+1 WHERE id=$1", [t.quote_id, input.status === "rejected" ? "rejected" : pending.rowCount ? "submitted" : "approved"]);
    }
    await repo.audit(db, req.actor, "处理报价审批", t.id, { status: input.status, comment: input.comment }); return { id: t.id };
  }));
  app.post("/api/quoting/versions/:id/issue", async (req, res) => mutate(req, res, async db => {
    const { q, p } = await quote(db, req.actor, id(req), true); repo.checkVersion(q, req.body.version);
    const today = businessDay((await repo.settings(db)).timezone);
    if (q.status !== "approved" || q.snapshot.issues.some(i => i.hard) || q.snapshot.total === null || q.snapshot.validThrough < today) throw new HttpError(422, "报价未通过全部审核、缺少数据或已过期");
    const latest = (await db.query("SELECT id FROM quotation_versions WHERE project_id=$1 ORDER BY number DESC LIMIT 1", [p.id])).rows[0];
    if (latest.id !== q.id) throw new HttpError(409, "只能发布最新版本");
    await db.query("UPDATE quotation_versions SET status='issued',issued_at=now(),version=version+1 WHERE id=$1", [q.id]); await repo.audit(db, req.actor, "正式发布报价", q.id); return { id: q.id };
  }));
  app.post("/api/quoting/versions/:id/confirm", async (req, res) => mutate(req, res, async db => {
    const { q, p } = await quote(db, req.actor, id(req), true); repo.checkVersion(q, req.body.version);
    const input = z.object({ contact: z.string().trim().min(1).max(100), evidence: z.string().trim().min(10).max(2000) }).parse(req.body);
    if (q.status !== "issued" || q.snapshot.validThrough < businessDay((await repo.settings(db)).timezone)) throw new HttpError(422, "只能确认有效的正式报价");
    const latest = (await db.query("SELECT id FROM quotation_versions WHERE project_id=$1 ORDER BY number DESC LIMIT 1", [p.id])).rows[0];
    if (latest.id !== q.id) throw new HttpError(409, "已有新版报价，请确认最新版本");
    const orderId = randomUUID(); await db.query("UPDATE quotation_versions SET status='confirmed',confirmed_at=now(),confirmation=$2,version=version+1 WHERE id=$1", [q.id, JSON.stringify(input)]);
    await db.query("INSERT INTO quotation_orders(id,project_id,quote_id,snapshot,created_by) VALUES($1,$2,$3,$4,$5)", [orderId, p.id, q.id, JSON.stringify({ input: q.input, calculation: q.snapshot, customer: q.customer_snapshot, confirmation: input }), req.actor.id]);
    const salesOrderId = randomUUID(), salesOrderNumber = `SO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${orderId.slice(0, 6).toUpperCase()}`;
    await db.query("INSERT INTO sales_orders(id,quotation_order_id,order_number,created_by) VALUES($1,$2,$3,$4)", [salesOrderId, orderId, salesOrderNumber, req.actor.id]);
    for (const line of q.input.lines) await db.query("INSERT INTO sales_order_items(id,sales_order_id,line_key,configuration_snapshot,quantity) VALUES($1,$2,$3,$4,$5)", [randomUUID(), salesOrderId, line.key, JSON.stringify(line), line.quantity]);
    await db.query("INSERT INTO quotation_reviews(id,quote_id,discipline) VALUES($1,$2,'production')", [randomUUID(), q.id]); await repo.audit(db, req.actor, "确认报价并生成订单", orderId, { quoteId: q.id, contact: input.contact }); return { id: orderId };
  }));
  app.post("/api/quoting/projects/:id/files", async (req, res) => mutate(req, res, async db => {
    const input = z.object({ name: z.string().min(1).max(160), mime: z.enum(["application/pdf", "image/png", "image/jpeg"]), data: z.string().max(2700000), kind: z.enum(["reference", "technical", "confirmation"]), taskId: z.uuid().optional() }).parse(req.body);
    await fileAccess(db, req.actor, id(req), input.taskId);
    if (input.kind === "technical" && !["admin", "technical"].includes(req.actor.role)) throw new HttpError(403, "只有管理员和技术员可上传审核图纸");
    if (input.kind === "confirmation" && !["admin", "sales"].includes(req.actor.role)) throw new HttpError(403, "无确认附件权限");
    const bytes = Buffer.from(input.data, "base64"); if (!bytes.length || bytes.length > 2e6) throw new HttpError(400, "附件必须小于2MB");
    const matches = input.mime === "application/pdf" ? bytes.subarray(0, 5).toString() === "%PDF-" : input.mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) : bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
    if (!matches) throw new HttpError(400, "附件格式与内容不一致");
    const fileId = randomUUID(); await db.query("INSERT INTO quotation_files(id,project_id,user_id,name,mime,bytes_base64,sha256,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [fileId, id(req), req.actor.id, input.name, input.mime, bytes.toString("base64"), createHash("sha256").update(bytes).digest("hex"), input.kind]); await repo.audit(db, req.actor, "上传报价附件", fileId); return { id: fileId };
  }));
  app.get("/api/quoting/files/:id", async (req, res) => {
    const f = (await pool.query("SELECT * FROM quotation_files WHERE id=$1", [id(req)])).rows[0]; if (!f) throw new HttpError(404, "附件不存在");
    await fileAccess(pool, req.actor, f.project_id, typeof req.query.task === "string" ? z.uuid().parse(req.query.task) : undefined);
    if (!["admin", "sales"].includes(req.actor.role) && f.kind === "confirmation") throw new HttpError(404, "附件不存在");
    res.set({ "Content-Type": f.mime, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`, "Content-Security-Policy": "sandbox" }).send(Buffer.from(f.bytes_base64, "base64"));
  });
  app.post("/api/quoting/versions/:id/documents", async (req, res) => {
    const input = z.object({ kind: z.enum(["quotation", "pi", "contract"]), language: z.enum(["en", "zh", "both"]) }).parse(req.body), { q } = await quote(pool, req.actor, id(req));
    if (!["issued", "confirmed"].includes(q.status) || (input.kind !== "quotation" && q.status !== "confirmed")) throw new HttpError(422, "报价须正式发布；PI/合同须先确认订单");
    const prior = (await pool.query("SELECT id FROM quotation_documents WHERE quote_id=$1 AND kind=$2 AND language=$3", [q.id, input.kind, input.language])).rows[0];
    if (prior) { res.json(prior); return; }
    // Chromium is outside the DB transaction; the authenticated session and ownership are rechecked before persistence.
    const bytes = await renderQuotePdf(q, input.kind, input.language), documentId = randomUUID();
    const saved = await transaction(pool, async db => {
      if (!(await db.query("SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active", [req.sessionHash])).rowCount) throw new HttpError(401, "会话已失效");
      await quote(db, req.actor, q.id, true);
      const result = await db.query("INSERT INTO quotation_documents(id,quote_id,kind,language,bytes_base64,sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(quote_id,kind,language) DO NOTHING RETURNING id", [documentId, q.id, input.kind, input.language, bytes.toString("base64"), createHash("sha256").update(bytes).digest("hex"), req.actor.id]);
      await repo.audit(db, req.actor, "生成报价PDF", q.id, input);
      return result.rows[0] || (await db.query("SELECT id FROM quotation_documents WHERE quote_id=$1 AND kind=$2 AND language=$3", [q.id, input.kind, input.language])).rows[0];
    }); res.json(saved);
  });
  app.get("/api/quoting/documents/:id", async (req, res) => {
    const doc = (await pool.query("SELECT * FROM quotation_documents WHERE id=$1", [id(req)])).rows[0]; if (!doc) throw new HttpError(404, "文件不存在"); await quote(pool, req.actor, doc.quote_id);
    await repo.audit(pool, req.actor, "下载报价PDF", doc.id);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `${req.query.inline === "1" ? "inline" : "attachment"}; filename="AUTINBERG-${doc.kind}-${doc.language}-${doc.id.slice(0, 8)}.pdf"`, "Content-Security-Policy": "sandbox" }).send(Buffer.from(doc.bytes_base64, "base64"));
  });
  app.get("/api/quoting/bundles", async (req, res) => { sales(req.actor); res.json((await pool.query("SELECT * FROM quotation_bundles WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100", [req.actor.id])).rows); });
  app.post("/api/quoting/bundles", async (req, res) => mutate(req, res, async db => {
    sales(req.actor); const input = z.object({ name: z.string().min(1).max(100), lines: z.array(lineSchema).min(1).max(100) }).parse(req.body), bundleId = randomUUID();
    await db.query("INSERT INTO quotation_bundles(id,user_id,name,lines) VALUES($1,$2,$3,$4)", [bundleId, req.actor.id, input.name, JSON.stringify(input.lines)]); return { id: bundleId };
  }));
  app.delete("/api/quoting/bundles/:id", async (req, res) => mutate(req, res, async db => { sales(req.actor); await db.query("DELETE FROM quotation_bundles WHERE id=$1 AND user_id=$2", [id(req), req.actor.id]); return { ok: true }; }));
  app.post("/api/quoting/import-lines", async (req, res) => {
    sales(req.actor); const input = z.object({ data: z.string().max(2700000) }).parse(req.body);
    const products = (await pool.query("SELECT id,sku,data FROM quotation_products WHERE (data->>'active')::boolean")).rows;
    res.json(await importLines(Buffer.from(input.data, "base64"), products));
  });
}
