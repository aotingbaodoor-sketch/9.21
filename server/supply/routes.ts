import type { Express, Request, Response } from "express";
import type pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { User } from "../../shared/contracts.ts";
import { factoryProductSchema } from "../../shared/factory.ts";
import { productSchema } from "../../shared/quoting.ts";
import { hashPassword, HttpError, requireAdmin } from "../domain.ts";
import * as repo from "../repository.ts";

type Mutate = (req: Request, res: Response, run: (db: pg.PoolClient) => Promise<unknown>) => Promise<void>;
const uid = (value: unknown) => z.uuid().parse(value);
const stages = ["order_confirmed", "drawing_confirmed", "materials", "cutting", "machining", "surface_treatment", "assembly", "glass", "hardware", "testing", "quality", "packing", "ready_to_ship", "shipped"] as const;

async function factoryForUser(db: pg.Pool | pg.PoolClient, actor: User) {
  const row = (await db.query("SELECT f.* FROM factory_users fu JOIN factories f ON f.id=fu.factory_id WHERE fu.user_id=$1 AND fu.status='approved' AND f.active AND f.deleted_at IS NULL", [actor.id])).rows[0];
  if (!row) throw new HttpError(403, "工厂账号尚未获批或已停用");
  return row;
}

async function requireFactoryPurchase(db: pg.Pool | pg.PoolClient, actor: User, purchaseOrderId: string) {
  if (actor.role !== "factory") return;
  const allowed = await db.query("SELECT 1 FROM purchase_orders po JOIN factory_users fu ON fu.factory_id=po.factory_id WHERE po.id=$1 AND fu.user_id=$2 AND fu.status='approved'", [purchaseOrderId, actor.id]);
  if (!allowed.rowCount) throw new HttpError(404, "工厂订单不存在或无权访问");
}

async function salesOrder(pool: pg.Pool | pg.PoolClient, actor: User, orderId: string) {
  const row = (await pool.query(
    `SELECT so.*,qo.quote_id,qo.snapshot,qp.customer_id,c.company,c.owner_id
       FROM sales_orders so
       JOIN quotation_orders qo ON qo.id=so.quotation_order_id
       JOIN quotation_projects qp ON qp.id=qo.project_id
       JOIN customers c ON c.id=qp.customer_id
      WHERE so.id=$1 AND c.deleted_at IS NULL
        AND ($2='admin' OR c.owner_id=$3 OR EXISTS(
          SELECT 1 FROM quotation_reviews r WHERE r.quote_id=qo.quote_id
          AND r.assigned_to=$3 AND r.discipline IN ('technical','logistics','production')
        ))`, [orderId, actor.role, actor.id]
  )).rows[0];
  if (!row) throw new HttpError(404, "订单不存在或无权访问");
  return row;
}

async function purchaseOrder(pool: pg.Pool | pg.PoolClient, actor: User, purchaseOrderId: string) {
  const row = (await pool.query(
    `SELECT po.*,so.order_number AS sales_order_number,so.id AS sales_order_id,f.name AS factory_name,
            qo.quote_id,qp.customer_id,c.company,c.owner_id
       FROM purchase_orders po
       JOIN sales_orders so ON so.id=po.sales_order_id
       JOIN quotation_orders qo ON qo.id=so.quotation_order_id
       JOIN quotation_projects qp ON qp.id=qo.project_id
       JOIN customers c ON c.id=qp.customer_id
       JOIN factories f ON f.id=po.factory_id
      WHERE po.id=$1 AND c.deleted_at IS NULL
        AND ($2='admin' OR c.owner_id=$3 OR EXISTS(
          SELECT 1 FROM quotation_reviews r WHERE r.quote_id=qo.quote_id
          AND r.assigned_to=$3 AND r.discipline IN ('technical','logistics','production')
        ) OR EXISTS(
          SELECT 1 FROM factory_users fu WHERE fu.factory_id=po.factory_id
          AND fu.user_id=$3 AND fu.status='approved'
        ))`, [purchaseOrderId, actor.role, actor.id]
  )).rows[0];
  if (!row) throw new HttpError(404, "工厂订单不存在或无权访问");
  return row;
}

export function registerSupplyRoutes(app: Express, pool: pg.Pool, mutate: Mutate) {
  app.get("/api/supply/orders", async (req, res) => {
    const rows = (await pool.query(
      `SELECT so.id,so.order_number,so.status,so.version,so.created_at,c.company,
        count(DISTINCT poi.id)::int AS items,count(DISTINCT po.id)::int AS purchase_orders
       FROM sales_orders so
       JOIN quotation_orders qo ON qo.id=so.quotation_order_id
       JOIN quotation_projects qp ON qp.id=qo.project_id JOIN customers c ON c.id=qp.customer_id
       LEFT JOIN sales_order_items soi ON soi.sales_order_id=so.id
       LEFT JOIN purchase_order_items poi ON poi.sales_order_item_id=soi.id
       LEFT JOIN purchase_orders po ON po.sales_order_id=so.id
       WHERE c.deleted_at IS NULL AND ($1='admin' OR c.owner_id=$2 OR EXISTS(
         SELECT 1 FROM quotation_reviews r WHERE r.quote_id=qo.quote_id AND r.assigned_to=$2
       )) GROUP BY so.id,c.company ORDER BY so.updated_at DESC LIMIT 500`, [req.actor.role, req.actor.id]
    )).rows;
    res.json(rows);
  });
  app.get("/api/supply/orders/:id", async (req, res) => {
    const order = await salesOrder(pool, req.actor, uid(req.params.id));
    const [items, purchases] = await Promise.all([
      pool.query("SELECT id,line_key,configuration_snapshot,quantity,version FROM sales_order_items WHERE sales_order_id=$1 ORDER BY line_key", [order.id]),
      pool.query("SELECT po.id,po.order_number,po.status,po.promised_date,po.version,f.name AS factory_name FROM purchase_orders po JOIN factories f ON f.id=po.factory_id WHERE po.sales_order_id=$1 ORDER BY po.created_at", [order.id]),
    ]);
    res.json({ order, items: items.rows, purchases: purchases.rows });
  });
  app.get("/api/supply/factories", async (req, res) => {
    if (req.actor.role === "factory") {
      const factory = await factoryForUser(pool, req.actor);
      res.json([factory]); return;
    }
    if (req.actor.role !== "admin") throw new HttpError(403, "仅管理员可查看全部工厂");
    res.json((await pool.query("SELECT f.id,f.name,f.contact,f.active,f.version,count(fu.user_id)::int AS accounts FROM factories f LEFT JOIN factory_users fu ON fu.factory_id=f.id AND fu.status='approved' WHERE f.deleted_at IS NULL GROUP BY f.id ORDER BY f.active DESC,f.name")).rows);
  });
  app.post("/api/supply/factories", async (req, res) => mutate(req, res, async db => {
    requireAdmin(req.actor);
    const input = z.object({ name: z.string().trim().min(2).max(160), contact: z.object({ person: z.string().trim().max(80).default(""), phone: z.string().trim().max(60).default(""), email: z.string().trim().max(200).default("") }).default({ person: "", phone: "", email: "" }) }).parse(req.body);
    const factoryId = randomUUID();
    await db.query("INSERT INTO factories(id,name,contact) VALUES($1,$2,$3)", [factoryId, input.name, JSON.stringify(input.contact)]);
    await repo.audit(db, req.actor, "新增合作工厂", factoryId, { name: input.name });
    return { id: factoryId };
  }));
  app.post("/api/supply/factories/:id/invite", async (req, res) => mutate(req, res, async db => {
    requireAdmin(req.actor);
    const factoryId = uid(req.params.id);
    const input = z.object({ name: z.string().trim().min(1).max(80), email: z.email().max(200).transform(v => v.toLowerCase()), password: z.string().min(12).max(128) }).parse(req.body);
    if (!(await db.query("SELECT 1 FROM factories WHERE id=$1 AND active AND deleted_at IS NULL", [factoryId])).rowCount) throw new HttpError(404, "工厂不存在或已停用");
    const userId = randomUUID(), passwordHash = await hashPassword(input.password);
    await db.query("INSERT INTO users(id,name,email,password_hash,role,active) VALUES($1,$2,$3,$4,'factory',true)", [userId, input.name, input.email, passwordHash]);
    await db.query("INSERT INTO factory_users(factory_id,user_id,status,is_primary,invited_by) VALUES($1,$2,'approved',true,$3)", [factoryId, userId, req.actor.id]);
    await repo.audit(db, req.actor, "邀请工厂账号", userId, { factoryId, email: input.email });
    return { id: userId };
  }));

  app.get("/api/supply/factory-products", async (req, res) => {
    let where = "fp.deleted_at IS NULL"; const params: unknown[] = [];
    if (req.actor.role === "factory") { const f = await factoryForUser(pool, req.actor); params.push(f.id); where += " AND fp.factory_id=$1"; }
    else if (req.actor.role !== "admin") throw new HttpError(403, "无工厂产品权限");
    res.json((await pool.query(`SELECT fp.*,f.name AS factory_name FROM factory_products fp JOIN factories f ON f.id=fp.factory_id WHERE ${where} ORDER BY fp.updated_at DESC LIMIT 1000`, params)).rows);
  });
  app.post("/api/supply/factory-products", async (req, res) => mutate(req, res, async db => {
    if (req.actor.role !== "factory") throw new HttpError(403, "只有工厂账号可录入供货产品");
    const factory = await factoryForUser(db, req.actor), input = factoryProductSchema.parse(req.body), productId = randomUUID();
    await db.query("INSERT INTO factory_products(id,factory_id,sku,name_zh,name_en,category,series,specification,image_urls,supply_price,currency,pricing_method,pricing_rule,lead_days,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)", [productId,factory.id,input.sku,input.nameZh,input.nameEn,input.category,input.series,input.specification,JSON.stringify(input.imageUrls),input.supplyPrice,input.currency,input.pricingMethod,JSON.stringify(input.pricingRule),input.leadDays,req.actor.id]);
    await repo.audit(db, req.actor, "工厂录入产品", productId, { factoryId: factory.id, sku: input.sku }); return { id: productId };
  }));
  app.put("/api/supply/factory-products/:id", async (req, res) => mutate(req, res, async db => {
    if (req.actor.role !== "factory") throw new HttpError(403, "只有工厂账号可修改供货产品");
    const factory = await factoryForUser(db, req.actor), input = factoryProductSchema.parse(req.body), productId = uid(req.params.id);
    const updated = await db.query("UPDATE factory_products SET sku=$3,name_zh=$4,name_en=$5,category=$6,series=$7,specification=$8,image_urls=$9,supply_price=$10,currency=$11,pricing_method=$12,pricing_rule=$13,lead_days=$14,status='draft',review_note='',version=version+1,updated_at=now() WHERE id=$1 AND factory_id=$2 AND status IN ('draft','rejected') AND version=$15 RETURNING id", [productId,factory.id,input.sku,input.nameZh,input.nameEn,input.category,input.series,input.specification,JSON.stringify(input.imageUrls),input.supplyPrice,input.currency,input.pricingMethod,JSON.stringify(input.pricingRule),input.leadDays,input.version]);
    if (!updated.rowCount) throw new HttpError(409, "产品已提交审核、已变化或不存在");
    await repo.audit(db, req.actor, "工厂修改产品", productId); return { id: productId };
  }));
  app.post("/api/supply/factory-products/:id/submit", async (req, res) => mutate(req, res, async db => {
    if (req.actor.role !== "factory") throw new HttpError(403, "只有工厂账号可提交审核");
    const factory = await factoryForUser(db, req.actor), productId = uid(req.params.id), version = z.number().int().positive().parse(req.body.version);
    const updated = await db.query("UPDATE factory_products SET status='submitted',submitted_at=now(),version=version+1,updated_at=now() WHERE id=$1 AND factory_id=$2 AND status IN ('draft','rejected') AND version=$3 RETURNING id", [productId,factory.id,version]);
    if (!updated.rowCount) throw new HttpError(409, "产品状态已变化，请刷新");
    await repo.audit(db, req.actor, "提交工厂产品审核", productId); return { id: productId };
  }));
  app.post("/api/supply/factory-products/:id/review", async (req, res) => mutate(req, res, async db => {
    requireAdmin(req.actor); const productId = uid(req.params.id);
    const input = z.object({ status: z.enum(["approved","rejected"]), note: z.string().trim().max(2000).default(""), guidePrice: z.number().min(0).max(1e9).nullable().default(null), minimumPrice: z.number().min(0).max(1e9).nullable().default(null), retailPrice: z.number().min(0).max(1e9).nullable().default(null), active: z.boolean().default(true), version: z.number().int().positive() }).parse(req.body);
    const row = (await db.query("SELECT * FROM factory_products WHERE id=$1 AND status='submitted' FOR UPDATE", [productId])).rows[0];
    if (!row) throw new HttpError(409, "产品不在待审核状态");
    if (row.version !== input.version) throw new HttpError(409, "产品已变化，请刷新");
    let approvedProductId = row.approved_product_id as string | null;
    if (input.status === "approved") {
      if (row.currency !== "CNY") throw new HttpError(422, "第一版发布目录前必须把供货价换算为人民币并重新提交");
      const product = productSchema.parse({ sku: row.sku, nameZh: row.name_zh, nameEn: row.name_en || row.name_zh, category: row.category, series: row.series, introduction: row.specification, active: input.active, leadDays: row.lead_days, pricing: row.pricing_method, prices: { factory: Number(row.supply_price), internal: Number(row.supply_price), guide: input.guidePrice, minimum: input.minimumPrice, retail: input.retailPrice, special: null }, standardSpecs: row.pricing_rule?.standardSpecs || {}, drawing: row.pricing_rule?.drawing || "custom" });
      if (approvedProductId) await db.query("UPDATE quotation_products SET sku=$2,data=$3,version=version+1,updated_at=now() WHERE id=$1", [approvedProductId, product.sku, JSON.stringify(product)]);
      else { approvedProductId = randomUUID(); await db.query("INSERT INTO quotation_products(id,sku,data) VALUES($1,$2,$3)", [approvedProductId, product.sku, JSON.stringify(product)]); }
    }
    await db.query("UPDATE factory_products SET status=$2,review_note=$3,approved_product_id=$4,reviewed_by=$5,reviewed_at=now(),version=version+1,updated_at=now() WHERE id=$1", [productId,input.status,input.note,approvedProductId,req.actor.id]);
    await repo.audit(db, req.actor, input.status === "approved" ? "审核通过并发布工厂产品" : "驳回工厂产品", productId, { approvedProductId, note: input.note }); return { id: productId, approvedProductId };
  }));
  app.post("/api/supply/orders/:id/purchase-orders", async (req, res) => mutate(req, res, async db => {
    requireAdmin(req.actor);
    const order = await salesOrder(db, req.actor, uid(req.params.id));
    const input = z.object({ factoryId: z.uuid(), itemIds: z.array(z.uuid()).min(1).max(500), promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null) }).parse(req.body);
    const factory = await db.query("SELECT id FROM factories WHERE id=$1 AND active AND deleted_at IS NULL", [input.factoryId]);
    if (!factory.rowCount) throw new HttpError(404, "合作工厂不存在或已停用");
    const lines = (await db.query("SELECT * FROM sales_order_items WHERE sales_order_id=$1 AND id=ANY($2::uuid[])", [order.id, input.itemIds])).rows;
    if (lines.length !== input.itemIds.length) throw new HttpError(400, "存在不属于本销售订单的产品");
    const poId = randomUUID();
    const number = `PO-${order.order_number.replace(/^SO-/, "")}-${String(Date.now()).slice(-6)}`;
    await db.query("INSERT INTO purchase_orders(id,sales_order_id,factory_id,order_number,promised_date,created_by) VALUES($1,$2,$3,$4,$5,$6)", [poId, order.id, input.factoryId, number, input.promisedDate, req.actor.id]);
    for (const line of lines) await db.query("INSERT INTO purchase_order_items(id,purchase_order_id,sales_order_item_id,quantity,configuration_snapshot) VALUES($1,$2,$3,$4,$5)", [randomUUID(), poId, line.id, line.quantity, JSON.stringify(line.configuration_snapshot)]);
    await repo.audit(db, req.actor, "拆分工厂采购订单", poId, { salesOrderId: order.id, factoryId: input.factoryId, itemCount: lines.length });
    return { id: poId };
  }));
  app.get("/api/supply/purchase-orders", async (req, res) => {
    let where = "TRUE", params: unknown[] = [];
    if (req.actor.role === "factory") { const f = await factoryForUser(pool, req.actor); where = "po.factory_id=$1"; params = [f.id]; }
    else if (req.actor.role === "sales") { where = "c.owner_id=$1"; params = [req.actor.id]; }
    else if (req.actor.role !== "admin") { where = "EXISTS(SELECT 1 FROM quotation_reviews r WHERE r.quote_id=qo.quote_id AND r.assigned_to=$1)"; params = [req.actor.id]; }
    const rows = (await pool.query(`SELECT po.id,po.order_number,po.status,po.promised_date,po.factory_confirmed_at,po.factory_confirmed_price,po.updated_at,f.name AS factory_name,c.company FROM purchase_orders po JOIN factories f ON f.id=po.factory_id JOIN sales_orders so ON so.id=po.sales_order_id JOIN quotation_orders qo ON qo.id=so.quotation_order_id JOIN quotation_projects qp ON qp.id=qo.project_id JOIN customers c ON c.id=qp.customer_id WHERE ${where} ORDER BY po.updated_at DESC LIMIT 500`, params)).rows;
    res.json(rows);
  });
  app.get("/api/supply/purchase-orders/:id", async (req, res) => {
    const order = await purchaseOrder(pool, req.actor, uid(req.params.id));
    await requireFactoryPurchase(pool, req.actor, order.id);
    const [items, updates, issues, inspections] = await Promise.all([
      pool.query("SELECT poi.*,soi.line_key FROM purchase_order_items poi JOIN sales_order_items soi ON soi.id=poi.sales_order_item_id WHERE poi.purchase_order_id=$1", [order.id]),
      pool.query("SELECT u.*,usr.name AS author FROM production_updates u JOIN users usr ON usr.id=u.created_by WHERE purchase_order_id=$1 ORDER BY created_at DESC", [order.id]),
      pool.query("SELECT i.*,usr.name AS author FROM production_issues i JOIN users usr ON usr.id=i.raised_by WHERE purchase_order_id=$1 ORDER BY created_at DESC", [order.id]),
      pool.query("SELECT q.*,usr.name AS inspector FROM quality_inspections q JOIN users usr ON usr.id=q.inspected_by WHERE purchase_order_id=$1 ORDER BY inspected_at DESC", [order.id]),
    ]);
    res.json({ order, items: items.rows, updates: updates.rows, issues: issues.rows, inspections: inspections.rows });
  });
  app.post("/api/supply/purchase-orders/:id/confirm", async (req, res) => mutate(req, res, async db => {
    if (req.actor.role !== "factory") throw new HttpError(403, "只有对应工厂账号可确认接单");
    const purchaseOrderId = uid(req.params.id);
    const input = z.object({ price: z.number().min(0).max(1e12), promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().trim().max(2000).default(""), version: z.number().int().positive() }).parse(req.body);
    const updated = await db.query(`UPDATE purchase_orders po
      SET status='accepted',factory_confirmed_at=now(),factory_confirmed_by=$2,
          factory_confirmed_price=$3,promised_date=$4,factory_confirmation_note=$5,
          version=version+1,updated_at=now()
      WHERE po.id=$1 AND po.version=$6 AND po.status IN ('draft','sent')
        AND EXISTS(SELECT 1 FROM factory_users fu WHERE fu.factory_id=po.factory_id
          AND fu.user_id=$2 AND fu.status='approved')
      RETURNING po.id`, [purchaseOrderId,req.actor.id,input.price,input.promisedDate,input.note,input.version]);
    if (!updated.rowCount) {
      await purchaseOrder(db, req.actor, purchaseOrderId);
      throw new HttpError(409, "订单已变化或不能重复确认");
    }
    await repo.audit(db, req.actor, "工厂确认接单", purchaseOrderId, { price: input.price, promisedDate: input.promisedDate }); return { id: purchaseOrderId };
  }));
  app.post("/api/supply/purchase-orders/:id/updates", async (req, res) => mutate(req, res, async db => {
    const order = await purchaseOrder(db, req.actor, uid(req.params.id));
    await requireFactoryPurchase(db, req.actor, order.id);
    if (!['admin', 'technical', 'factory'].includes(req.actor.role)) throw new HttpError(403, "只有工厂、管理员或已分配技术人员可更新生产进度");
    const input = z.object({ stage: z.enum(stages), plannedAt: z.string().datetime().nullable().default(null), actualAt: z.string().datetime().nullable().default(null), quantity: z.number().int().min(0).max(1000000).default(0), note: z.string().trim().max(3000).default("") }).parse(req.body);
    await db.query("INSERT INTO production_updates(id,purchase_order_id,stage,planned_at,actual_at,quantity,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [randomUUID(), order.id, input.stage, input.plannedAt, input.actualAt, input.quantity, input.note, req.actor.id]);
    await db.query("UPDATE purchase_orders SET status=CASE WHEN $2='shipped' THEN 'shipped' WHEN $2 IN ('ready_to_ship','packing') THEN 'ready' WHEN status='draft' THEN 'in_production' ELSE status END,updated_at=now(),version=version+1 WHERE id=$1", [order.id, input.stage]);
    await repo.audit(db, req.actor, "更新生产节点", order.id, { stage: input.stage, quantity: input.quantity });
    return { ok: true };
  }));
  app.post("/api/supply/purchase-orders/:id/issues", async (req, res) => mutate(req, res, async db => {
    const order = await purchaseOrder(db, req.actor, uid(req.params.id));
    await requireFactoryPurchase(db, req.actor, order.id);
    if (!['admin', 'technical', 'factory'].includes(req.actor.role)) throw new HttpError(403, "无生产异常提交权限");
    const input = z.object({ severity: z.enum(['low','medium','high','critical']), description: z.string().trim().min(5).max(4000) }).parse(req.body);
    const issueId = randomUUID();
    await db.query("INSERT INTO production_issues(id,purchase_order_id,severity,description,raised_by) VALUES($1,$2,$3,$4,$5)", [issueId, order.id, input.severity, input.description, req.actor.id]);
    await repo.audit(db, req.actor, "提交生产异常", issueId, { purchaseOrderId: order.id, severity: input.severity });
    return { id: issueId };
  }));
  app.post("/api/supply/purchase-orders/:id/quality", async (req, res) => mutate(req, res, async db => {
    const order = await purchaseOrder(db, req.actor, uid(req.params.id));
    if (!['admin', 'technical'].includes(req.actor.role)) throw new HttpError(403, "无质检记录权限");
    const input = z.object({ status: z.enum(['passed','failed','conditional']), note: z.string().trim().max(3000).default("") }).parse(req.body);
    const inspectionId = randomUUID();
    await db.query("INSERT INTO quality_inspections(id,purchase_order_id,status,note,inspected_by) VALUES($1,$2,$3,$4,$5)", [inspectionId, order.id, input.status, input.note, req.actor.id]);
    await db.query("UPDATE purchase_orders SET status=$2,updated_at=now(),version=version+1 WHERE id=$1", [order.id, input.status === 'failed' ? 'quality_hold' : input.status === 'passed' ? 'ready' : order.status]);
    await repo.audit(db, req.actor, "记录产品质检", inspectionId, { purchaseOrderId: order.id, status: input.status });
    return { id: inspectionId };
  }));
  app.post("/api/supply/purchase-orders/:id/media", async (req, res) => mutate(req, res, async db => {
    const order = await purchaseOrder(db, req.actor, uid(req.params.id)); await requireFactoryPurchase(db, req.actor, order.id);
    if (!['admin','technical','factory'].includes(req.actor.role)) throw new HttpError(403, "无生产资料上传权限");
    const input = z.object({ updateId: z.uuid().nullable().default(null), kind: z.enum(['photo','video','document']), name: z.string().trim().min(1).max(180), mime: z.enum(['image/jpeg','image/png','image/webp','video/mp4','application/pdf']), data: z.string().max(11000000) }).parse(req.body);
    const bytes = Buffer.from(input.data, 'base64'); if (!bytes.length || bytes.length > 8e6) throw new HttpError(400, "单个文件不能超过8MB");
    if (input.updateId && !(await db.query("SELECT 1 FROM production_updates WHERE id=$1 AND purchase_order_id=$2", [input.updateId,order.id])).rowCount) throw new HttpError(404, "生产节点不存在");
    const mediaId=randomUUID(); await db.query("INSERT INTO production_media(id,purchase_order_id,production_update_id,kind,name,mime,bytes_base64,sha256,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [mediaId,order.id,input.updateId,input.kind,input.name,input.mime,bytes.toString('base64'),createHash('sha256').update(bytes).digest('hex'),req.actor.id]);
    await repo.audit(db, req.actor, "上传生产资料", mediaId, { purchaseOrderId: order.id, kind: input.kind }); return { id: mediaId };
  }));
}
