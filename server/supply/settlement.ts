import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type { Express, Request, Response } from "express";
import type pg from "pg";
import { z } from "zod";
import type { Db } from "../db.ts";
import type { User } from "../../shared/contracts.ts";
import { HttpError, requireAdmin, businessDay } from "../domain.ts";
import * as repo from "../repository.ts";
import { registerDocumentInTransaction } from "../document-registry.ts";
import { workOrder, validProjectFile, event } from "./chain.ts";
import { shippingReady } from "./fulfillment.ts";
type Mutate = (
  req: Request,
  res: Response,
  run: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;
const uid = z.uuid(),
  text = z.string().trim().min(2).max(1000),
  optionalFile = uid.nullable().default(null);
const termsSchema = z
  .object({
    method: z.enum(["A", "B", "C"]),
    customerForwarder: z.boolean(),
    billType: z.enum(["to_order", "telex", "named", "seaway"]),
    depositPercent: z.number().min(30).max(100),
    contractFileId: uid,
    repeatFileId: optionalFile,
    namedConsentFileId: optionalFile,
    guaranteeFileId: optionalFile,
    blDraftFileId: optionalFile,
    blChecks: z
      .object({
        shipper: z.boolean(),
        consignee: z.boolean(),
        goods: z.boolean(),
        quantity: z.boolean(),
        amount: z.boolean(),
        seal: z.boolean(),
      })
      .strict(),
  })
  .strict();
export async function financialActor(
  db: Db,
  actor: User,
  kind: "finance" | "release" | "cs" | "scm",
) {
  requireAdmin(actor);
  const p = (
    await db.query("SELECT * FROM crm_fulfillment_approvers WHERE id=1")
  ).rows[0];
  if (!p?.[kind + "_user_id"])
    throw new HttpError(
      409,
      `尚未配置${({finance:'财务核验',release:'放单审批',cs:'客户关系确认',scm:'供应链关闭审批'})[kind]}人员，不能自动通过；请到系统设置配置`,
    );
  if (p[kind + "_user_id"] !== actor.id)
    throw new HttpError(403, "仅配置中的核验人员可以执行此操作");
}
export async function settlement(db: Db, id: string) {
  const q = (
    await db.query(
      `SELECT v.snapshot->>'total' total,v.input->>'currency' currency,d.data deposit
 FROM crm_work_orders w JOIN sales_orders so ON so.id=w.sales_order_id JOIN quotation_orders qo ON qo.id=so.quotation_order_id
 JOIN quotation_versions v ON v.id=qo.quote_id JOIN quotation_deposits d ON d.quotation_order_id=qo.id WHERE w.id=$1`,
      [id],
    )
  ).rows[0];
  if (!q || !q.total || !new Decimal(q.total).isPositive())
    throw new HttpError(409, "缺少有效正式报价总额，不能核算付款");
  const receipts = (
    await db.query(
      "SELECT r.*,d.doc_no FROM crm_order_receipts r JOIN crm_document_registry d ON d.id=r.document_id WHERE r.work_order_id=$1 ORDER BY confirmed_at",
      [id],
    )
  ).rows;
  if (
    q.deposit.currency !== q.currency ||
    receipts.some((r) => r.currency !== q.currency)
  )
    throw new HttpError(
      409,
      "收款与报价币种不一致，须先人工核对，禁止猜测换算",
    );
  const paid = receipts.reduce(
    (sum: Decimal, r: any) => sum.plus(r.amount),
    new Decimal(q.deposit.amount),
  );
  return {
    currency: q.currency,
    total: new Decimal(q.total).toFixed(2),
    paid: paid.toFixed(2),
    remaining: Decimal.max(new Decimal(q.total).minus(paid), 0).toFixed(2),
    settled: paid.gte(q.total),
    receipts,
  };
}
export function assertShipmentPayment(
  t: any,
  s: Awaited<ReturnType<typeof settlement>>,
) {
  if (t.method === "C" && !["to_order", "named"].includes(t.bill_type))
    throw new HttpError(
      409,
      "客户指定货代须使用To Order或经书面同意的记名提单",
    );
  const paid = new Decimal(s.paid),
    total = new Decimal(s.total);
  if (paid.lt(total.mul(t.deposit_percent).div(100)))
    throw new HttpError(
      409,
      "未达到合同定金比例；低于30%须全体股东会签，目前未开放例外",
    );
  if (t.method === "A" && !s.settled)
    throw new HttpError(409, "方式A必须装船前结清");
  if (t.method === "C" && !s.settled && paid.lt(total.mul("0.5")))
    throw new HttpError(409, "方式C须已付至少50%或装船前结清，不能使用方式B");
  if (t.bill_type === "seaway" && !s.settled)
    throw new HttpError(409, "未全额收款禁止海运单");
  if (
    t.method === "C" &&
    (!t.guarantee_file_id ||
      !t.bl_draft_file_id ||
      !Object.values(t.bl_checks).every((x) => x === true))
  )
    throw new HttpError(409, "客户指定货代缺放货保函或提单草稿六项核对");
}
export function registerSettlement(
  app: Express,
  pool: pg.Pool,
  mutate: Mutate,
) {
  app.get("/api/settings/fulfillment-approvers", async (req, res) => {
    requireAdmin(req.actor);
    res.json(
      (await pool.query("SELECT * FROM crm_fulfillment_approvers WHERE id=1"))
        .rows[0],
    );
  });
  app.put("/api/settings/fulfillment-approvers", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const input = z
        .object({
          financeUserId: uid.nullable(),
          releaseUserId: uid.nullable(),
          csUserId: uid.nullable().optional(),
          scmUserId: uid.nullable().optional(),
        })
        .strict()
        .parse(req.body);
      for (const id of new Set(
        [input.financeUserId, input.releaseUserId,input.csUserId,input.scmUserId].filter(Boolean),
      ))
        if (
          !(
            await db.query(
              "SELECT 1 FROM users WHERE id=$1 AND active AND role='admin'",
              [id],
            )
          ).rowCount
        )
          throw new HttpError(
            422,
            "当前仅支持明确授权的在职管理员担任核验人，不按姓名推定身份",
          );
      const before = (
        await db.query(
          "SELECT * FROM crm_fulfillment_approvers WHERE id=1 FOR UPDATE",
        )
      ).rows[0];
      await db.query(
        "UPDATE crm_fulfillment_approvers SET finance_user_id=$1,release_user_id=$2,updated_by=$3,updated_at=now(),cs_user_id=$4,scm_user_id=$5 WHERE id=1",
        [input.financeUserId, input.releaseUserId, req.actor.id,input.csUserId===undefined?before.cs_user_id:input.csUserId,input.scmUserId===undefined?before.scm_user_id:input.scmUserId],
      );
      await repo.audit(
        db,
        req.actor,
        "配置履约核验职责",
        "fulfillment-approvers",
        { before, after: input },
      );
      return input;
    }),
  );
  app.get("/api/supply/chain/:id/settlement", async (req, res) => {
    const w = await workOrder(pool, req.actor, uid.parse(req.params.id));
    const [terms, release, forwarder, next] = await Promise.all([
      pool.query(
        "SELECT * FROM crm_order_payment_terms WHERE work_order_id=$1",
        [w.id],
      ),
      pool.query("SELECT * FROM crm_document_releases WHERE work_order_id=$1", [
        w.id,
      ]),
      pool.query("SELECT * FROM crm_order_forwarders WHERE work_order_id=$1", [
        w.id,
      ]),
      pool.query(
        "SELECT * FROM crm_fulfillment_stage WHERE ordinal=(SELECT ordinal+1 FROM crm_fulfillment_stage WHERE code=$1)",
        [w.current_stage],
      ),
    ]);
    const s = await settlement(pool, w.id);
    // Receipt files and bank references are financial/internal data, never exposed to ordinary sales.
    res.json({
      terms: terms.rows[0] ?? null,
      release: release.rows[0]
        ? {
            releasedAt: release.rows[0].released_at,
            type: release.rows[0].release_type,
          }
        : null,
      forwarder: forwarder.rows[0] ?? null,
      next: next.rows[0] ?? null,
      ...s,
      receipts: req.actor.role === "admin" ? s.receipts : [],
    });
  });
  app.post("/api/supply/chain/:id/payment-terms", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const w = await workOrder(db, req.actor, uid.parse(req.params.id), true),
        i = termsSchema.parse(req.body);
      if ((i.method === "C") !== i.customerForwarder)
        throw new HttpError(
          422,
          "客户指定货代必须选C，C不能与见提单副本付款B并用",
        );
      if (i.method === "B" && !i.repeatFileId)
        throw new HttpError(422, "方式B须提供复购依据");
      if (i.method === "C" && !["to_order", "named"].includes(i.billType))
        throw new HttpError(
          422,
          "客户指定货代须使用To Order或经书面同意的记名提单",
        );
      if (i.billType === "named" && !i.namedConsentFileId)
        throw new HttpError(422, "记名提单须我方书面同意");
      for (const id of [
        i.contractFileId,
        i.repeatFileId,
        i.namedConsentFileId,
        i.guaranteeFileId,
        i.blDraftFileId,
      ].filter(Boolean))
        await validProjectFile(db, id!, w.project_id);
      const s = await settlement(db, w.id);
      if (i.billType === "seaway" && !s.settled)
        throw new HttpError(409, "未结清不能确认使用海运单");
      if (
        (
          await db.query(
            "SELECT 1 FROM crm_order_payment_terms WHERE work_order_id=$1",
            [w.id],
          )
        ).rowCount
      )
        throw new HttpError(409, "合同付款条件已锁定，变更须走审批，不可覆盖");
      await db.query(
        `INSERT INTO crm_order_payment_terms(work_order_id,method,customer_forwarder,bill_type,deposit_percent,contract_file_id,repeat_file_id,named_consent_file_id,guarantee_file_id,bl_draft_file_id,bl_checks,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          w.id,
          i.method,
          i.customerForwarder,
          i.billType,
          i.depositPercent,
          i.contractFileId,
          i.repeatFileId,
          i.namedConsentFileId,
          i.guaranteeFileId,
          i.blDraftFileId,
          JSON.stringify(i.blChecks),
          req.actor.id,
        ],
      );
      await repo.audit(db, req.actor, "核实并锁定合同付款依据", w.id, {
        method: i.method,
        billType: i.billType,
        contractFileId: i.contractFileId,
      });
      return { id: w.id };
    }),
  );
  app.post("/api/supply/chain/:id/receipts", async (req, res) =>
    mutate(req, res, async (db) => {
      await financialActor(db, req.actor, "finance");
      const w = await workOrder(db, req.actor, uid.parse(req.params.id), true);
      const i = z
        .object({
          amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/),
          currency: z.string().regex(/^[A-Z]{3}$/),
          bankReference: text,
          receivedAt: z.iso.datetime(),
          fileId: uid,
        })
        .strict()
        .parse(req.body);
      const s = await settlement(db, w.id);
      if (
        !new Decimal(i.amount).isPositive() ||
        i.currency !== s.currency ||
        Date.parse(i.receivedAt) > Date.now()
      )
        throw new HttpError(422, "金额、币种或实际到账时间无效");
      await validProjectFile(db, i.fileId, w.project_id);
      const reference = i.bankReference.toUpperCase();
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "receipt:" + reference,
      ]);
      if (
        (
          await db.query(
            "SELECT 1 FROM quotation_deposits WHERE upper(trim(data->>'reference'))=$1",
            [reference],
          )
        ).rowCount
      )
        throw new HttpError(409, "该银行流水已经作为定金入账，不能重复登记");
      const old = (
        await db.query(
          "SELECT r.*,d.doc_no FROM crm_order_receipts r JOIN crm_document_registry d ON d.id=r.document_id WHERE bank_reference=$1",
          [reference],
        )
      ).rows[0];
      if (old) {
        if (
          old.work_order_id !== w.id ||
          !new Decimal(old.amount).eq(i.amount) ||
          old.file_id !== i.fileId ||
          old.currency !== i.currency ||
          new Date(old.received_at).toISOString() !==
            new Date(i.receivedAt).toISOString()
        )
          throw new HttpError(409, "银行流水已登记且内容不一致");
        return { id: old.id, docNo: old.doc_no };
      }
      const id = randomUUID();
      const doc = await registerDocumentInTransaction(
        db,
        {
          classCode: "AR",
          customerIds: [w.customer_id],
          date: businessDay((await repo.settings(db)).timezone),
          businessKind: "fulfillment_receipt",
          businessId: id,
          requestKey: uid.parse(req.get("idempotency-key")),
          actorId: req.actor.id,
        },
        async (tx, d) => {
          await tx.query(
            "INSERT INTO crm_order_receipts(id,document_id,work_order_id,amount,currency,bank_reference,file_id,received_at,confirmed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              id,
              d.id,
              w.id,
              i.amount,
              i.currency,
              reference,
              i.fileId,
              i.receivedAt,
              req.actor.id,
            ],
          );
        },
      );
      await repo.audit(db, req.actor, "财务核实收款", id, {
        workOrderId: w.id,
        docNo: doc.doc_no,
      });
      return { id, docNo: doc.doc_no };
    }),
  );
  app.post("/api/supply/chain/:id/forwarder", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const w = await workOrder(db, req.actor, uid.parse(req.params.id), true);
      const i = z
        .object({
          source: z.enum(["customer_nominated", "we_arranged"]),
          company: text,
          contact: text,
          channel: text,
          pickupAt: z.iso.datetime(),
          port: text,
          vehicle: text,
          driver: text,
          fileId: uid,
        })
        .strict()
        .parse(req.body);
      await validProjectFile(db, i.fileId, w.project_id);
      const t = (
        await db.query(
          "SELECT * FROM crm_order_payment_terms WHERE work_order_id=$1",
          [w.id],
        )
      ).rows[0];
      if (!t || t.customer_forwarder !== (i.source === "customer_nominated"))
        throw new HttpError(409, "货代来源须与已核实的合同付款条件一致");
      if (
        (
          await db.query(
            "SELECT 1 FROM crm_order_forwarders WHERE work_order_id=$1",
            [w.id],
          )
        ).rowCount
      )
        throw new HttpError(409, "货代记录已锁定，变更需要审批");
      await db.query(
        "INSERT INTO crm_order_forwarders(work_order_id,source,company,contact,channel,pickup_at,port,vehicle,driver,file_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          w.id,
          i.source,
          i.company,
          i.contact,
          i.channel,
          i.pickupAt,
          i.port,
          i.vehicle,
          i.driver,
          i.fileId,
          req.actor.id,
        ],
      );
      await repo.audit(db, req.actor, "核实货代与提货安排", w.id, {
        source: i.source,
        fileId: i.fileId,
      });
      return { id: w.id };
    }),
  );
  app.post("/api/supply/chain/:id/release", async (req, res) =>
    mutate(req, res, async (db) => {
      await financialActor(db, req.actor, "release");
      const w = await workOrder(db, req.actor, uid.parse(req.params.id), true);
      const i = z
        .object({
          releaseType: z.enum(["original_bl", "telex", "delivery_permit"]),
          fileId: uid,
          confirmSettled: z.literal(true),
        })
        .strict()
        .parse(req.body);
      await validProjectFile(db, i.fileId, w.project_id);
      const s = await settlement(db, w.id);
      if (!s.settled)
        throw new HttpError(
          409,
          "G-12：尾款未结清，不得释放正本提单、电放指令或放货许可",
        );
      if (
        !(
          await db.query(
            "SELECT 1 FROM crm_fulfillment_stage WHERE code=$1 AND ordinal>=14",
            [w.current_stage],
          )
        ).rowCount
      )
        throw new HttpError(409, "须先核实装船/提单节点，不允许提前放单");
      const old = (
        await db.query(
          "SELECT * FROM crm_document_releases WHERE work_order_id=$1",
          [w.id],
        )
      ).rows[0];
      if (old) {
        if (old.release_type !== i.releaseType || old.file_id !== i.fileId)
          throw new HttpError(409, "放单凭证不可覆盖");
        return { id: w.id };
      }
      await db.query(
        "INSERT INTO crm_document_releases(work_order_id,release_type,file_id,released_by,settlement_snapshot) VALUES($1,$2,$3,$4,$5)",
        [
          w.id,
          i.releaseType,
          i.fileId,
          req.actor.id,
          JSON.stringify({
            currency: s.currency,
            total: s.total,
            paid: s.paid,
          }),
        ],
      );
      await repo.audit(db, req.actor, "人工核验结清并同意放单", w.id, {
        releaseType: i.releaseType,
        fileId: i.fileId,
      });
      return { id: w.id };
    }),
  );
  const allowed = [
    "sample_approved",
    "production_done",
    "packed",
    "shipment_checked",
    "forwarder_assigned",
    "picked_up",
    "loaded",
    "export_cleared",
    "shipped",
    "departed",
    "arrived",
    "dest_cleared",
    "balance_settled",
  ] as const;
  app.post("/api/supply/chain/:id/verify-stage", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const w = await workOrder(db, req.actor, uid.parse(req.params.id), true);
      const i = z
        .object({
          stage: z.enum(allowed),
          fileId: uid,
          note: text,
          occurredAt: z.iso.datetime(),
        })
        .strict()
        .parse(req.body);
      if (Date.parse(i.occurredAt) > Date.now())
        throw new HttpError(422, "实际发生时间不能在未来");
      const next = (
        await db.query(
          "SELECT code FROM crm_fulfillment_stage WHERE ordinal=(SELECT ordinal+1 FROM crm_fulfillment_stage WHERE code=$1)",
          [w.current_stage],
        )
      ).rows[0];
      if (next?.code !== i.stage)
        throw new HttpError(409, "必须顺序核实节点，禁止跳级或倒退");
      await validProjectFile(db, i.fileId, w.project_id);
      if (w.trade_term !== "FOB")
        throw new HttpError(409, "EXW适用性待确认，未自动跳过");
      if (["production_done", "shipment_checked"].includes(i.stage)) {
        const purchases = (
          await db.query(
            "SELECT id FROM purchase_orders WHERE work_order_id=$1 AND status<>'cancelled' ORDER BY id FOR UPDATE",
            [w.id],
          )
        ).rows;
        if (!purchases.length) throw new HttpError(409, "缺少有效采购订单");
        for (const p of purchases) await shippingReady(db, p.id);
      }
      if (i.stage === "packed") {
        const ready = (
          await db.query(
            `SELECT NOT EXISTS(SELECT 1 FROM purchase_order_items pi JOIN purchase_orders p ON p.id=pi.purchase_order_id WHERE p.work_order_id=$1 AND p.status<>'cancelled' AND pi.quantity>(SELECT coalesce(sum(si.quantity),0) FROM shipment_package_items si WHERE si.purchase_order_item_id=pi.id)) ready`,
            [w.id],
          )
        ).rows[0].ready;
        if (!ready) throw new HttpError(409, "全部产品实际包装数量尚未齐备");
      }
      if (
        ["forwarder_assigned", "picked_up"].includes(i.stage) &&
        !(
          await db.query(
            "SELECT 1 FROM crm_order_forwarders WHERE work_order_id=$1",
            [w.id],
          )
        ).rowCount
      )
        throw new HttpError(409, "G-15：须先核实货代来源、车辆、司机及装运港");
      const required: Record<string, string[]> = {
        picked_up: ["pickup_receipt", "packing_evidence"],
        export_cleared: ["export_release"],
        shipped: ["bl_copy"],
        departed: ["departure_notice"],
        arrived: ["arrival_notice"],
        dest_cleared: ["destination_release"],
      };
      for (const type of required[i.stage] ?? []) {
        if (
          !(
            await db.query(
              "SELECT 1 FROM crm_logistics_documents WHERE work_order_id=$1 AND doc_type=$2 AND check_result='matched' AND ($2<>'bl_copy' OR length(trim(external_no))>0)",
              [w.id, type],
            )
          ).rowCount
        )
          throw new HttpError(409, `缺少已回传并核对一致的凭证：${type}`);
      }
      // Contract A/C gates actual on-board shipment; container loading is a distinct earlier node.
      if (["shipped", "departed"].includes(i.stage)) {
        const t = (
          await db.query(
            "SELECT * FROM crm_order_payment_terms WHERE work_order_id=$1",
            [w.id],
          )
        ).rows[0];
        if (!t) throw new HttpError(409, "须先核实A/B/C合同付款方式及提单类型");
        assertShipmentPayment(t, await settlement(db, w.id));
      }
      if (i.stage === "balance_settled") {
        await financialActor(db, req.actor, "finance");
        if (!(await settlement(db, w.id)).settled)
          throw new HttpError(409, "实际到账未结清，不能仅勾选尾款结清");
      }
      await event(db, w, req.actor, i.stage, {
        fileId: i.fileId,
        note: i.note,
        occurredAt: i.occurredAt,
      });
      return { id: w.id, stage: i.stage };
    }),
  );
}
