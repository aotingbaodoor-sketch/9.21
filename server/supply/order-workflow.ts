import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db.ts";
import type { User } from "../../shared/contracts.ts";
import { HttpError, requireAdmin } from "../domain.ts";
import {
  orderMilestones,
  requireOrderTransition,
  requireProductionDraft,
  requireProductionExecution,
  requireProductionInstruction,
  type OrderEvidence,
  type OrderMilestone,
} from "./order-policy.ts";

const note = z.string().trim().min(2).max(2000);
export const orderEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("deposit"),
      amount: z.number().positive().max(1e12),
      currency: z.string().regex(/^[A-Z]{3}$/),
      receivedAt: z.iso.datetime(),
      reference: note,
    })
    .strict(),
  z.object({ kind: z.literal("measurement"), fileId: z.uuid(), note }).strict(),
  z
    .object({
      kind: z.literal("dimensions"),
      measurementId: z.uuid(),
      lines: z
        .array(
          z
            .object({
              itemId: z.uuid(),
              widthMm: z.number().positive().max(100000),
              heightMm: z.number().positive().max(100000),
            })
            .strict(),
        )
        .min(1)
        .max(1000),
      note,
    })
    .strict(),
  z.object({ kind: z.literal("instruction"), note }).strict(),
  z
    .object({
      kind: z.literal("installation"),
      fileId: z.uuid(),
      confirmedAt: z.iso.datetime(),
      note,
    })
    .strict(),
]);

export async function orderWorkflow(db: Db, orderId: string) {
  const quote = (
    await db.query(
      `SELECT q.status,q.issued_at,q.snapshot,q.id AS quote_id,qo.project_id FROM sales_orders so
    JOIN quotation_orders qo ON qo.id=so.quotation_order_id JOIN quotation_versions q ON q.id=qo.quote_id WHERE so.id=$1`,
      [orderId],
    )
  ).rows[0];
  if (!quote) throw new HttpError(404, "订单不存在");
  const records = (
    await db.query(
      "SELECT * FROM order_evidence WHERE sales_order_id=$1 ORDER BY created_at,id",
      [orderId],
    )
  ).rows;
  const events = (
    await db.query(
      "SELECT * FROM order_milestone_events WHERE sales_order_id=$1 ORDER BY created_at,id",
      [orderId],
    )
  ).rows;
  const latest = (kind: string) => records.findLast((r) => r.kind === kind);
  const measurement = latest("measurement"),
    dimensions = latest("dimensions");
  const evidence: OrderEvidence = {
    informationComplete:
      Array.isArray(quote.snapshot.issues) &&
      !quote.snapshot.issues.some((i: { hard?: boolean }) => i.hard) &&
      quote.snapshot.total != null,
    formalQuoteIssued:
      !!quote.issued_at && ["issued", "confirmed"].includes(quote.status),
    depositReceived: !!latest("deposit"),
    measurementUploaded: !!measurement,
    finalDimensionsConfirmed:
      !!dimensions && dimensions.data.measurementId === measurement?.id,
    productionInstructionIssued: !!latest("instruction"),
    outgoingInspectionPassed: false,
    shipmentRecorded: false,
    installationConfirmed: !!latest("installation"),
  };
  // A single dispatched carton must not mark the entire order as shipped.
  const shipping = (
    await db.query(
      `SELECT
    EXISTS(SELECT 1 FROM purchase_orders WHERE sales_order_id=$1 AND status<>'cancelled') AND
    NOT EXISTS(SELECT 1 FROM purchase_orders po WHERE po.sales_order_id=$1 AND po.status<>'cancelled' AND
      coalesce((SELECT qi.status FROM quality_inspections qi WHERE qi.purchase_order_id=po.id ORDER BY qi.inspected_at DESC,qi.id DESC LIMIT 1),'pending')<>'passed') AS quality,
    EXISTS(SELECT 1 FROM sales_order_items WHERE sales_order_id=$1) AND
    NOT EXISTS(SELECT 1 FROM sales_order_items si WHERE si.sales_order_id=$1 AND si.quantity>
      (SELECT coalesce(sum(spi.quantity),0) FROM shipment_package_items spi
       JOIN shipment_package_allocations spa ON spa.package_id=spi.package_id JOIN shipments s ON s.id=spa.shipment_id
       JOIN purchase_order_items poi ON poi.id=spi.purchase_order_item_id WHERE poi.sales_order_item_id=si.id AND s.status IN ('dispatched','received'))) AS shipped`,
      [orderId],
    )
  ).rows[0];
  evidence.outgoingInspectionPassed = shipping.quality;
  evidence.shipmentRecorded = shipping.shipped;
  return {
    state: (events.at(-1)?.to_state ?? "资料") as OrderMilestone,
    evidence,
    records,
    events,
    quote,
  };
}

export async function requireOrderDraft(db: Db, orderId: string) {
  await requireNotCancelled(db, orderId);
  requireProductionDraft((await orderWorkflow(db, orderId)).evidence);
}
export async function requireOrderExecution(db: Db, orderId: string) {
  await requireNotCancelled(db, orderId);
  requireProductionExecution((await orderWorkflow(db, orderId)).evidence);
}
async function requireNotCancelled(db: Db, orderId: string) {
  const row = (
    await db.query("SELECT status FROM sales_orders WHERE id=$1", [orderId])
  ).rows[0];
  if (!row || row.status === "cancelled")
    throw new HttpError(409, "订单不存在或已取消");
}

async function advance(
  db: Db,
  orderId: string,
  actor: User,
  automatic: boolean,
) {
  const current = await orderWorkflow(db, orderId);
  let state = current.state;
  for (const next of orderMilestones.slice(
    orderMilestones.indexOf(state) + 1,
  )) {
    try {
      requireOrderTransition(state, next, current.evidence);
    } catch (e) {
      if (e instanceof HttpError) break;
      throw e;
    }
    await db.query(
      "INSERT INTO order_milestone_events(id,sales_order_id,from_state,to_state,actor_id,automatic,basis) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        randomUUID(),
        orderId,
        state,
        next,
        actor.id,
        automatic,
        JSON.stringify({
          label: automatic ? "系统自动通过" : "人工确认通过",
          quoteId: current.quote.quote_id,
          evidenceIds: current.records.map((r) => r.id),
        }),
      ],
    );
    const fulfillment =
      next === "生产中"
        ? "production"
        : next === "已发货"
          ? "shipped"
          : next === "已安装/完结"
            ? "closed"
            : null;
    // Backfilling evidence on a legacy order must not rewind its actual fulfillment history.
    if (fulfillment)
      await db.query(
        `UPDATE sales_orders SET status=CASE
      WHEN $2='production' AND status IN ('quality','ready_to_ship','shipped','closed') THEN status
      WHEN $2='shipped' AND status='closed' THEN status ELSE $2 END,
      version=version+1,updated_at=now() WHERE id=$1`,
        [orderId, fulfillment],
      );
    state = next;
  }
  return state;
}

export async function syncOrderMilestones(
  db: Db,
  orderId: string,
  actor: User,
) {
  await db.query("SELECT id FROM sales_orders WHERE id=$1 FOR UPDATE", [
    orderId,
  ]);
  return advance(db, orderId, actor, true);
}

// Caller must have authorized access to the order. All mutations use its transaction.
export async function recordOrderEvidence(
  db: Db,
  actor: User,
  orderId: string,
  raw: unknown,
) {
  const input = orderEvidenceSchema.parse(raw);
  if (input.kind === "deposit" || input.kind === "instruction")
    requireAdmin(actor);
  else if (!["admin", "technical"].includes(actor.role))
    throw new HttpError(403, "仅管理员或已分配技术员可登记核验资料");
  const locked = (
    await db.query(
      "SELECT id,status FROM sales_orders WHERE id=$1 FOR UPDATE",
      [orderId],
    )
  ).rows[0];
  if (!locked || locked.status === "cancelled")
    throw new HttpError(409, "订单不存在或已取消");
  const current = await orderWorkflow(db, orderId);
  if (
    ["measurement", "dimensions"].includes(input.kind) &&
    current.evidence.productionInstructionIssued
  )
    throw new HttpError(
      409,
      "已下达生产指令，不能直接更换量尺或尺寸；须先走生产变更审核",
    );
  if (input.kind === "deposit" && Date.parse(input.receivedAt) > Date.now())
    throw new HttpError(422, "到账时间不能在未来");
  if (input.kind === "measurement" || input.kind === "installation") {
    const file = (
      await db.query(
        "SELECT id FROM quotation_files WHERE id=$1 AND project_id=$2 AND kind IN ('reference','technical','confirmation')",
        [input.fileId, current.quote.project_id],
      )
    ).rows[0];
    if (!file) throw new HttpError(422, "必须上传本订单项目的有效证明附件");
  }
  if (input.kind === "dimensions") {
    const latest = current.records.findLast((r) => r.kind === "measurement");
    if (!latest || latest.id !== input.measurementId)
      throw new HttpError(409, "请根据最新量尺记录确认尺寸");
    const items = (
      await db.query(
        "SELECT id FROM sales_order_items WHERE sales_order_id=$1",
        [orderId],
      )
    ).rows.map((r) => r.id);
    const submitted = new Set(input.lines.map((l) => l.itemId));
    if (
      submitted.size !== input.lines.length ||
      submitted.size !== items.length ||
      items.some((id) => !submitted.has(id))
    )
      throw new HttpError(
        422,
        "最终尺寸必须逐项覆盖本订单所有产品，不得重复或引用其他订单",
      );
  }
  if (input.kind === "instruction") {
    if (current.evidence.productionInstructionIssued)
      throw new HttpError(409, "生产指令已经下达，不可重复");
    requireProductionInstruction(current.evidence);
  }
  if (input.kind === "installation") {
    requireProductionExecution(current.evidence);
    if (Date.parse(input.confirmedAt) > Date.now())
      throw new HttpError(422, "安装时间不能在未来");
    if (
      !current.evidence.shipmentRecorded ||
      !current.evidence.outgoingInspectionPassed
    )
      throw new HttpError(409, "完成出货检验及全部发货后才能确认安装");
  }
  const evidenceId = randomUUID();
  const data =
    input.kind === "instruction"
      ? {
          ...input,
          dimensions: current.records.findLast((r) => r.kind === "dimensions")
            ?.data,
          prerequisiteIds: current.records.map((r) => r.id),
        }
      : input;
  await db.query(
    "INSERT INTO order_evidence(id,sales_order_id,kind,data,created_by) VALUES($1,$2,$3,$4,$5)",
    [evidenceId, orderId, input.kind, JSON.stringify(data), actor.id],
  );
  const state = await advance(db, orderId, actor, true);
  return { id: evidenceId, state };
}
