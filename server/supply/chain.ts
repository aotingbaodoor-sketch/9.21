import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type pg from "pg";
import { z } from "zod";
import type { Db } from "../db.ts";
import type { User } from "../../shared/contracts.ts";
import { HttpError, requireAdmin, businessDay } from "../domain.ts";
import * as repo from "../repository.ts";
import { registerDocumentInTransaction } from "../document-registry.ts";
import { orderWorkflow } from "./order-workflow.ts";
import { requireProductionInstruction } from "./order-policy.ts";
import { purchaseOrder } from "./access.ts";
import {
  manufacturingExcel,
  manufacturingPdf,
} from "./manufacturing-export.ts";

type Mutate = (
  req: Request,
  res: Response,
  run: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;
const uid = z.uuid();
const text = z.string().trim().min(1).max(2000);
const date = z.iso.date();
const supplierWarrantyV21 = [
  { part: "型材 / 中空玻璃 / 木质面板", months: 24 },
  { part: "表面处理", months: 36 },
  { part: "五金 / 密封胶条", months: 18 },
  { part: "玻璃自爆", months: 12 },
  { part: "运输破损索赔", days: 30 },
];
const technical = z
  .object({
    profile: text,
    glass: text,
    hardware: text,
    finish: text,
    sampleReference: text,
    packing: text,
    requiredDate: date,
  })
  .strict();
const joins = `FROM crm_work_orders w JOIN crm_document_registry d ON d.id=w.document_id
 JOIN customers c ON c.id=w.customer_id JOIN sales_orders so ON so.id=w.sales_order_id
 JOIN quotation_orders qo ON qo.id=so.quotation_order_id`;
const scope = `( $1='admin' OR ($1='sales' AND c.owner_id=$2) OR ($1 IN ('technical','logistics','coordinator') AND w.scm_owner=$2))`;
export async function workOrder(db: Db, actor: User, id: string, lock = false) {
  const row = (
    await db.query(
      `SELECT w.*,d.doc_no,so.order_number,c.company,c.owner_id,qo.project_id ${joins}
 WHERE w.id=$3 AND c.deleted_at IS NULL AND ${scope} ${lock ? "FOR UPDATE OF w" : ""}`,
      [actor.role, actor.id, id],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "工单不存在或未授权");
  return row;
}
export async function event(
  db: Db,
  w: { id: string; customer_id: string; current_stage: string },
  actor: User,
  to: string,
  basis: object,
) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO crm_fulfillment_events(id,work_order_id,from_stage,to_stage,actor_id,basis) VALUES($1,$2,$3,$4,$5,$6)",
    [id, w.id, w.current_stage, to, actor.id, JSON.stringify(basis)],
  );
  await db.query(
    "UPDATE crm_order_progress SET status='completed',completed_at=now(),completed_by=$3 WHERE work_order_id=$1 AND stage_code=$2 AND status='pending'",
    [w.id, to, actor.id],
  );
  await db.query(
    "UPDATE crm_work_orders SET current_stage=$2,version=version+1 WHERE id=$1",
    [w.id, to],
  );
  const stage = (
    await db.query(
      "SELECT name_cn,visibility FROM crm_fulfillment_stage WHERE code=$1",
      [to],
    )
  ).rows[0];
  if (stage.visibility !== "none")
    await db.query(
      `INSERT INTO crm_fulfillment_notice_drafts(id,event_id,work_order_id,customer_id,content) VALUES($1,$2,$3,$4,$5)`,
      [
        randomUUID(),
        id,
        w.id,
        w.customer_id,
        `已核实进度：${stage.name_cn}。请人工核对后再发送。`,
      ],
    );
  await repo.audit(db, actor, "订单履约节点完成", w.id, {
    from: w.current_stage,
    to,
    basis,
    eventId: id,
  });
}
/** Called inside the legacy PO transaction: neither UI nor direct HTTP can bypass G-10. */
export async function requireIssuedWorkOrder(db: Db, salesOrderId: string) {
  const w = (
    await db.query(
      "SELECT * FROM crm_work_orders WHERE sales_order_id=$1 FOR UPDATE",
      [salesOrderId],
    )
  ).rows[0];
  if (!w)
    throw new HttpError(
      409,
      "G-10：请先在“订单履约链”签发工单 WO，再开立采购订单",
    );
  if (!["wo_issued", "po_issued"].includes(w.current_stage))
    throw new HttpError(409, "工单已进入生产环节，新增采购须先走变更审批");
  return w;
}
export async function attachPurchaseToWorkOrder(
  db: Db,
  actor: User,
  w: any,
  purchaseId: string,
) {
  await db.query("UPDATE purchase_orders SET work_order_id=$2 WHERE id=$1", [
    purchaseId,
    w.id,
  ]);
  if (w.current_stage === "wo_issued")
    await event(db, w, actor, "po_issued", { purchaseId });
}
export async function requireNumberedManufacturing(
  db: Db,
  actor: User,
  salesOrderId: string,
) {
  const w = (
    await db.query(
      "SELECT * FROM crm_work_orders WHERE sales_order_id=$1 FOR UPDATE",
      [salesOrderId],
    )
  ).rows[0];
  if (!w) throw new HttpError(409, "G-10/G-14：请先签发WO及关联PO的正式MO");
  await workOrder(db, actor, w.id);
  const ready = (
    await db.query(
      `SELECT EXISTS(SELECT 1 FROM purchase_orders WHERE work_order_id=$1 AND status<>'cancelled') AND
 NOT EXISTS(SELECT 1 FROM purchase_orders p WHERE p.work_order_id=$1 AND p.status<>'cancelled'
 AND NOT EXISTS(SELECT 1 FROM crm_manufacturing_orders m WHERE m.purchase_order_id=p.id)) AS ready`,
      [w.id],
    )
  ).rows[0].ready;
  if (!ready)
    throw new HttpError(409, "G-14：每张有效PO必须有已签发、关联一致的MO");
  if (w.current_stage !== "material_ready")
    throw new HttpError(409, "原材料备齐及IQC凭证核实后才能确认投产");
  return w;
}
export async function recordNumberedProductionStart(
  db: Db,
  actor: User,
  w: any,
  evidenceId: string,
) {
  await event(db, w, actor, "in_production", {
    productionEvidenceId: evidenceId,
  });
}
/** Reject identity leakage in free text as well as in structured fields. Never log rejected content. */
export async function factorySafe(db: Db, value: unknown) {
  const body = JSON.stringify(value).toLocaleLowerCase();
  if (
    /客户名称|customer name|终端客户|end customer|客户成交价|终端零售价|采购价|成本|底价|利润|\b(?:cost|profit|margin)\b|@|https?:\/\//i.test(
      body,
    )
  )
    throw new HttpError(
      422,
      "G-19：工厂版内容含受限身份或销售字段，请删除后重试",
    );
  const rows = (await db.query("SELECT company,data FROM customers")).rows;
  for (const c of rows) {
    const identifiers = [
      c.company,
      c.data?.contact,
      c.data?.contactName,
      c.data?.email,
      c.data?.phone,
      c.data?.whatsapp,
      c.data?.address,
    ].filter((s) => typeof s === "string" && s.trim().length > 1);
    if (
      identifiers.some((s: string) =>
        body.includes(s.trim().toLocaleLowerCase()),
      )
    )
      throw new HttpError(
        422,
        "G-19：工厂版内容命中客户身份资料，请删除后重试",
      );
  }
}
export async function validProjectFile(db: Db, fileId: string, projectId: string) {
  if (
    !(
      await db.query(
        "SELECT 1 FROM quotation_files WHERE id=$1 AND project_id=$2 AND kind IN ('confirmation','technical','reference')",
        [fileId, projectId],
      )
    ).rowCount
  )
    throw new HttpError(422, "附件必须为本订单项目已上传的有效凭证");
}
export function registerOrderChain(
  app: Express,
  pool: pg.Pool,
  mutate: Mutate,
) {
  app.get("/api/supply/chain", async (req, res) => {
    const rows = (
      await pool.query(
        `SELECT w.id,w.customer_id,w.customer_code,w.current_stage,w.expected_delivery,w.trade_term,d.doc_no,c.company,so.order_number ${joins} WHERE c.deleted_at IS NULL AND ${scope} ORDER BY w.created_at DESC LIMIT 500`,
        [req.actor.role, req.actor.id],
      )
    ).rows;
    const candidates =
      req.actor.role === "admin"
        ? (
            await pool.query(`SELECT so.id,so.order_number,c.company,c.crm_customer_code,qo.project_id FROM sales_orders so
    JOIN quotation_orders qo ON qo.id=so.quotation_order_id JOIN quotation_projects qp ON qp.id=qo.project_id JOIN customers c ON c.id=qp.customer_id
    WHERE so.status<>'cancelled' AND c.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM crm_work_orders w WHERE w.sales_order_id=so.id) ORDER BY so.created_at DESC`)
          ).rows
        : [];
    res.json({ orders: rows, candidates });
  });
  app.post("/api/supply/chain", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const input = z
        .object({
          salesOrderId: uid,
          expectedDelivery: date,
          confirmationFileId: uid,
          orderType: z.enum(["sample", "bulk", "replacement"]),
          tradeTerm: z.enum(["FOB", "EXW"]).default("FOB"),
        })
        .strict()
        .parse(req.body);
      if (input.tradeTerm === "EXW")
        throw new HttpError(
          409,
          "EXW报关适用性存在文件冲突，等待业务确认；未自动跳过节点",
        );
      const so = (
        await db.query(
          `SELECT so.id,so.status,qp.customer_id,qp.id project_id,c.crm_customer_code,c.owner_id,qd.document_id,qd.created_at AS deposit_confirmed_at,qd.created_by AS deposit_confirmed_by
   FROM sales_orders so JOIN quotation_orders qo ON qo.id=so.quotation_order_id JOIN quotation_projects qp ON qp.id=qo.project_id
   JOIN customers c ON c.id=qp.customer_id LEFT JOIN quotation_deposits qd ON qd.quotation_order_id=qo.id
   WHERE so.id=$1 AND c.deleted_at IS NULL FOR UPDATE OF so`,
          [input.salesOrderId],
        )
      ).rows[0];
      if (!so || so.status === "cancelled")
        throw new HttpError(404, "有效销售订单不存在");
      if (!so.document_id)
        throw new HttpError(
          409,
          "G-11：缺少财务已登记的收款确认单，不能签发工单",
        );
      if (!so.crm_customer_code)
        throw new HttpError(
          409,
          "G-18：请先核实客户首次开发资料并取得永久客户编号",
        );
      await validProjectFile(db, input.confirmationFileId, so.project_id);
      const prior = (
        await db.query(
          "SELECT w.*,d.doc_no FROM crm_work_orders w JOIN crm_document_registry d ON d.id=w.document_id WHERE w.sales_order_id=$1",
          [so.id],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.expected_delivery !== input.expectedDelivery ||
          prior.confirmation_file_id !== input.confirmationFileId ||
          prior.order_type !== input.orderType ||
          prior.trade_term !== input.tradeTerm
        )
          throw new HttpError(
            409,
            "已签发WO内容不可由重复开单覆盖，请走变更审批",
          );
        return { id: prior.id, docNo: prior.doc_no };
      }
      const id = randomUUID();
      const result = await registerDocumentInTransaction(
        db,
        {
          classCode: "WO",
          customerIds: [so.customer_id],
          date: businessDay((await repo.settings(db)).timezone),
          businessKind: "order_work_order",
          businessId: so.id,
          requestKey: uid.parse(req.get("idempotency-key")),
          actorId: req.actor.id,
        },
        async (tx, d) => {
          await tx.query(
            `INSERT INTO crm_work_orders(id,document_id,sales_order_id,customer_id,customer_code,order_type,expected_delivery,trade_term,confirmation_file_id,receipt_document_id,sales_owner,created_by,current_stage)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'deposit_confirmed')`,
            [
              id,
              d.id,
              so.id,
              so.customer_id,
              so.crm_customer_code,
              input.orderType,
              input.expectedDelivery,
              input.tradeTerm,
              input.confirmationFileId,
              so.document_id,
              so.owner_id,
              req.actor.id,
            ],
          );
          await tx.query(
            "INSERT INTO crm_order_progress(work_order_id,stage_code) SELECT $1,code FROM crm_fulfillment_stage",
            [id],
          );
          await tx.query(
            "UPDATE crm_order_progress SET status='completed',completed_at=$4,completed_by=$2,evidence_id=$3 WHERE work_order_id=$1 AND stage_code='deposit_confirmed'",
            [
              id,
              so.deposit_confirmed_by,
              so.document_id,
              so.deposit_confirmed_at,
            ],
          );
          await event(
            tx,
            {
              id,
              customer_id: so.customer_id,
              current_stage: "deposit_confirmed",
            },
            req.actor,
            "wo_issued",
            {
              receiptDocumentId: so.document_id,
              confirmationFileId: input.confirmationFileId,
            },
          );
        },
      );
      return { id, docNo: result.doc_no };
    }),
  );
  app.get("/api/supply/chain/:id", async (req, res) => {
    const w = await workOrder(pool, req.actor, uid.parse(req.params.id));
    const [
      progress,
      events,
      purchases,
      instructions,
      files,
      logistics,
      types,
      notices,
    ] = await Promise.all([
      pool.query(
        "SELECT s.*,p.* FROM crm_order_progress p JOIN crm_fulfillment_stage s ON s.code=p.stage_code WHERE p.work_order_id=$1 ORDER BY s.ordinal",
        [w.id],
      ),
      pool.query(
        "SELECT e.*,u.name actor FROM crm_fulfillment_events e JOIN users u ON u.id=e.actor_id WHERE e.work_order_id=$1 ORDER BY e.at",
        [w.id],
      ),
      pool.query(
        "SELECT id,order_number,status FROM purchase_orders WHERE work_order_id=$1 ORDER BY created_at",
        [w.id],
      ),
      pool.query(
        "SELECT m.id,m.purchase_order_id,d.doc_no,m.created_at FROM crm_manufacturing_orders m JOIN crm_document_registry d ON d.id=m.document_id WHERE m.work_order_id=$1",
        [w.id],
      ),
      pool.query(
        "SELECT id,name,kind,created_at FROM quotation_files WHERE project_id=$1 ORDER BY created_at",
        [w.project_id],
      ),
      pool.query(
        "SELECT l.*,t.name_cn FROM crm_logistics_documents l JOIN crm_logistics_doc_type t ON t.code=l.doc_type WHERE work_order_id=$1 ORDER BY created_at",
        [w.id],
      ),
      pool.query("SELECT * FROM crm_logistics_doc_type ORDER BY code"),
      pool.query(
        "SELECT id,content,status,created_at FROM crm_fulfillment_notice_drafts WHERE work_order_id=$1 ORDER BY created_at",
        [w.id],
      ),
    ]);
    res.json({
      order: w,
      progress: progress.rows,
      events: events.rows,
      purchases: purchases.rows,
      instructions: instructions.rows,
      files: files.rows,
      logistics: logistics.rows,
      docTypes: types.rows,
      notices: notices.rows,
    });
  });
  app.post("/api/supply/chain/:id/manufacturing", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const w = await workOrder(db, req.actor, uid.parse(req.params.id), true);
      const input = z
        .object({ purchaseOrderId: uid, technical })
        .strict()
        .parse(req.body);
      const po = await purchaseOrder(
        db,
        req.actor,
        input.purchaseOrderId,
        true,
      );
      if (
        po.work_order_id !== w.id ||
        po.sales_order_id !== w.sales_order_id ||
        po.status === "cancelled"
      )
        throw new HttpError(409, "G-14/G-18：采购订单不属于该工单或已取消");
      const workflow = await orderWorkflow(db, w.sales_order_id);
      requireProductionInstruction(workflow.evidence);
      const dimensions =
        workflow.records.findLast((r) => r.kind === "dimensions")?.data.lines ??
        [];
      const items = (
        await db.query(
          "SELECT pi.quantity,si.line_key,si.id FROM purchase_order_items pi JOIN sales_order_items si ON si.id=pi.sales_order_item_id WHERE pi.purchase_order_id=$1",
          [po.id],
        )
      ).rows
        .map((i) => ({
          line: i.line_key,
          quantity: i.quantity,
          ...dimensions.find((d: any) => d.itemId === i.id),
        }))
        .map(({ itemId: _itemId, ...i }) => i);
      if (!items.length || items.some((i) => !i.widthMm || !i.heightMm))
        throw new HttpError(409, "MO必须逐项包含数量及已确认尺寸");
      await factorySafe(db, input.technical);
      const prior = (
        await db.query(
          "SELECT m.id,m.technical_snapshot,d.doc_no FROM crm_manufacturing_orders m JOIN crm_document_registry d ON d.id=m.document_id WHERE m.purchase_order_id=$1",
          [po.id],
        )
      ).rows[0];
      if (prior) {
        if (
          Object.entries(input.technical).some(
            ([key, value]) => prior.technical_snapshot[key] !== value,
          )
        )
          throw new HttpError(
            409,
            "已签发MO不可覆盖技术要求，请走变更审批和重新签发",
          );
        return { id: prior.id, docNo: prior.doc_no };
      }
      const id = randomUUID();
      const document = await registerDocumentInTransaction(
        db,
        {
          classCode: "MO",
          customerIds: [w.customer_id],
          date: businessDay((await repo.settings(db)).timezone),
          businessKind: "manufacturing_order",
          businessId: po.id,
          requestKey: uid.parse(req.get("idempotency-key")),
          actorId: req.actor.id,
        },
        async (tx, d) => {
          await factorySafe(tx, { ...input.technical, items });
          await tx.query(
            "INSERT INTO crm_manufacturing_orders(id,document_id,work_order_id,purchase_order_id,customer_id,customer_code,technical_snapshot,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              id,
              d.id,
              w.id,
              po.id,
              w.customer_id,
              w.customer_code,
              JSON.stringify({
                ...input.technical,
                items,
                supplierWarranty: supplierWarrantyV21,
                templateVersion: "MO-20261004-V2.1",
              }),
              req.actor.id,
            ],
          );
        },
      );
      await repo.audit(db, req.actor, "签发生产指令单 MO", id, {
        docNo: document.doc_no,
        workOrderId: w.id,
        purchaseOrderId: po.id,
      });
      return { id, docNo: document.doc_no };
    }),
  );
  app.post("/api/supply/chain/:id/logistics", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const w = await workOrder(db, req.actor, uid.parse(req.params.id), true);
      const input = z
        .object({
          docType: text,
          fileId: uid,
          sourceName: text,
          receivedOn: z.iso.datetime(),
          externalNo: z.string().trim().max(200).default(""),
        })
        .strict()
        .parse(req.body);
      if (Date.parse(input.receivedOn) > Date.now())
        throw new HttpError(422, "回传时间不能在未来");
      if (
        !(
          await db.query("SELECT 1 FROM crm_logistics_doc_type WHERE code=$1", [
            input.docType,
          ])
        ).rowCount
      )
        throw new HttpError(400, "未登记的物流回传类型");
      await validProjectFile(db, input.fileId, w.project_id);
      const id = randomUUID();
      await db.query(
        "INSERT INTO crm_logistics_documents(id,work_order_id,customer_id,doc_type,file_id,source_name,received_on,external_no,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          w.id,
          w.customer_id,
          input.docType,
          input.fileId,
          input.sourceName,
          input.receivedOn,
          input.externalNo,
          req.actor.id,
        ],
      );
      await repo.audit(db, req.actor, "登记物流回传件", id, {
        workOrderId: w.id,
        docType: input.docType,
        fileId: input.fileId,
      });
      return { id };
    }),
  );
  app.post(
    "/api/supply/chain/:id/logistics/:documentId/check",
    async (req, res) =>
      mutate(req, res, async (db) => {
        requireAdmin(req.actor);
        const w = await workOrder(
          db,
          req.actor,
          uid.parse(req.params.id),
          true,
        );
        const input = z
          .object({ result: z.enum(["matched", "mismatch"]) })
          .strict()
          .parse(req.body);
        const changed = await db.query(
          "UPDATE crm_logistics_documents SET check_result=$3,checked_by=$4,checked_at=now() WHERE id=$1 AND work_order_id=$2 RETURNING id",
          [uid.parse(req.params.documentId), w.id, input.result, req.actor.id],
        );
        if (!changed.rowCount) throw new HttpError(404, "回传记录不存在");
        await repo.audit(
          db,
          req.actor,
          "核对物流回传件",
          String(req.params.documentId),
          { result: input.result },
        );
        return { id: req.params.documentId };
      }),
  );
  // Only explicitly implemented evidence gates can advance. A label alone is never evidence.
  app.post("/api/supply/chain/:id/advance", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const w = await workOrder(db, req.actor, uid.parse(req.params.id), true);
      const input = z
        .object({
          stage: z.literal("material_ready"),
          fileId: uid,
          inspectionResult: z.literal("passed"),
          note: text,
        })
        .strict()
        .parse(req.body);
      if (w.current_stage !== "po_issued")
        throw new HttpError(409, "仅已下达采购的工单可核实原材料备齐");
      await validProjectFile(db, input.fileId, w.project_id);
      await event(db, w, req.actor, "material_ready", { ...input });
      return { id: w.id, stage: "material_ready" };
    }),
  );
  app.get(
    [
      "/api/supply/manufacturing/:id",
      "/api/supply/manufacturing/:id/export/:format",
    ],
    async (req, res) => {
      const m = (
        await pool.query(
          `SELECT m.*,d.doc_no,wd.doc_no wo_no,p.order_number po_no FROM crm_manufacturing_orders m
   JOIN crm_document_registry d ON d.id=m.document_id JOIN crm_work_orders w ON w.id=m.work_order_id
   JOIN crm_document_registry wd ON wd.id=w.document_id JOIN purchase_orders p ON p.id=m.purchase_order_id WHERE m.id=$1`,
          [uid.parse(req.params.id)],
        )
      ).rows[0];
      if (!m) throw new HttpError(404, "生产指令不存在");
      if (req.actor.role === "factory")
        await purchaseOrder(pool, req.actor, m.purchase_order_id);
      else await workOrder(pool, req.actor, m.work_order_id);
      await factorySafe(pool, m.technical_snapshot);
      // Allow-list projection, including for administrators: this endpoint IS the factory version.
      const view = {
        id: m.id,
        docNo: m.doc_no,
        customerCode: m.customer_code,
        woNo: m.wo_no,
        poNo: m.po_no,
        technical: m.technical_snapshot,
        issuedAt: m.created_at,
        audience: "factory",
        warranty: m.technical_snapshot.supplierWarranty,
      };
      if (req.params.format) {
        const format = z.enum(["pdf", "xlsx"]).parse(req.params.format);
        const bytes =
          format === "pdf"
            ? await manufacturingPdf(view)
            : await manufacturingExcel(view);
        await repo.audit(pool, req.actor, "下载工厂版生产指令", m.id, {
          format,
          docNo: m.doc_no,
          audience: "factory",
        });
        res
          .set("Cache-Control", "private, no-store")
          .set(
            "Content-Disposition",
            `attachment; filename="${m.doc_no}.${format}"`,
          )
          .type(
            format === "pdf"
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          )
          .send(bytes);
      } else res.json(view);
    },
  );
}
