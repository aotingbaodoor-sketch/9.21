import type { Express, Request, Response } from "express";
import type pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  productionStages,
  reviewSchema,
  packageSchema,
  shipmentSchema,
} from "../../shared/supply.ts";
import { businessDay, HttpError, requireAdmin } from "../domain.ts";
import * as repo from "../repository.ts";
import { purchaseOrder, operator, reviewer, type SupplyDb } from "./access.ts";

type Mutate = (
  req: Request,
  res: Response,
  run: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;
const id = (req: Request) => z.uuid().parse(req.params.id);
const version = z.number().int().positive();
const note = z.string().trim().min(2).max(3000);
function active(order: Record<string, unknown>) {
  if (
    !order.factory_confirmed_at ||
    ["draft", "sent", "cancelled", "shipped"].includes(String(order.status))
  )
    throw new HttpError(409, "订单尚未接单或已结束，不能继续修改生产数据");
}
async function orderedQuantity(db: SupplyDb, orderId: string) {
  return Number(
    (
      await db.query(
        "SELECT coalesce(sum(quantity),0) AS quantity FROM purchase_order_items WHERE purchase_order_id=$1",
        [orderId],
      )
    ).rows[0].quantity,
  );
}
async function shippingReady(db: SupplyDb, orderId: string) {
  const quality = (
    await db.query(
      "SELECT status,inspected_at FROM quality_inspections WHERE purchase_order_id=$1 ORDER BY inspected_at DESC,id DESC LIMIT 1",
      [orderId],
    )
  ).rows[0];
  if (quality?.status !== "passed")
    throw new HttpError(422, "最新公司质检必须通过后才能发货");
  if (
    (
      await db.query(
        "SELECT 1 FROM rework_tasks WHERE purchase_order_id=$1 AND (status<>'closed' OR reviewed_at>$2) LIMIT 1",
        [orderId, quality.inspected_at],
      )
    ).rowCount
  )
    throw new HttpError(422, "返工尚未关闭或返工后尚未重新质检");
  if (
    (
      await db.query(
        "SELECT 1 FROM production_issues WHERE purchase_order_id=$1 AND status IN ('open','mitigating') AND severity IN ('high','critical') LIMIT 1",
        [orderId],
      )
    ).rowCount
  )
    throw new HttpError(422, "高风险生产异常尚未解决");
}
async function syncShipmentState(db: SupplyDb, orderId: string) {
  const total = await orderedQuantity(db, orderId);
  const summary = (
    await db.query(
      `SELECT coalesce(sum(i.quantity) FILTER(WHERE s.status IN ('dispatched','received')),0)::int AS sent,
    coalesce(sum(i.quantity) FILTER(WHERE s.status='received'),0)::int AS received
    FROM shipments s JOIN shipment_package_allocations a ON a.shipment_id=s.id
    JOIN shipment_package_items i ON i.package_id=a.package_id WHERE s.purchase_order_id=$1`,
      [orderId],
    )
  ).rows[0];
  await db.query(
    "UPDATE purchase_orders SET status=CASE WHEN $2>= $3 THEN 'shipped' ELSE 'ready' END,version=version+1,updated_at=now() WHERE id=$1",
    [orderId, summary.sent, total],
  );
  if (summary.received >= total)
    await db.query(
      `UPDATE sales_orders so SET status='closed',updated_at=now(),version=version+1
    WHERE so.id=(SELECT sales_order_id FROM purchase_orders WHERE id=$1)
      AND NOT EXISTS(SELECT 1 FROM sales_order_items si WHERE si.sales_order_id=so.id AND NOT EXISTS(
        SELECT 1 FROM purchase_order_items pi JOIN purchase_orders po ON po.id=pi.purchase_order_id WHERE pi.sales_order_item_id=si.id AND po.status='shipped'))
      AND NOT EXISTS(SELECT 1 FROM purchase_orders po JOIN shipments s ON s.purchase_order_id=po.id WHERE po.sales_order_id=so.id AND s.status<>'received')`,
      [orderId],
    );
}
export function registerFulfillment(
  app: Express,
  pool: pg.Pool,
  mutate: Mutate,
) {
  app.post("/api/supply/purchase-orders/:id/assign", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const order = await purchaseOrder(db, req.actor, id(req), true);
      const input = z.object({ userId: z.uuid(), version }).parse(req.body);
      repo.checkVersion(order, input.version);
      if (
        !(
          await db.query(
            "SELECT 1 FROM users WHERE id=$1 AND active AND role IN ('coordinator','technical','logistics')",
            [input.userId],
          )
        ).rowCount
      )
        throw new HttpError(400, "请选择已启用的跟单、技术或物流人员");
      await db.query(
        "UPDATE purchase_orders SET coordinator_id=$2,version=version+1,updated_at=now() WHERE id=$1",
        [order.id, input.userId],
      );
      await repo.audit(db, req.actor, "分配订单跟单人员", order.id, {
        userId: input.userId,
      });
      return { id: order.id };
    }),
  );
  app.get("/api/supply/purchase-orders/:id/fulfillment", async (req, res) => {
    const order = await purchaseOrder(pool, req.actor, id(req));
    const [media, reworks, packages, shipments, progress, settings] =
      await Promise.all([
        pool.query(
          "SELECT id,production_update_id,kind,name,mime,created_at FROM production_media WHERE purchase_order_id=$1 ORDER BY created_at",
          [order.id],
        ),
        pool.query(
          "SELECT * FROM rework_tasks WHERE purchase_order_id=$1 ORDER BY created_at",
          [order.id],
        ),
        pool.query(
          `SELECT p.*,p.length_mm*p.width_mm*p.height_mm/1e9 AS cbm,
        (SELECT json_agg(json_build_object('itemId',i.purchase_order_item_id,'quantity',i.quantity)) FROM shipment_package_items i WHERE i.package_id=p.id) AS items,
        a.shipment_id FROM shipment_packages p LEFT JOIN shipment_package_allocations a ON a.package_id=p.id WHERE p.purchase_order_id=$1 ORDER BY p.created_at`,
          [order.id],
        ),
        pool.query(
          `SELECT s.*,(SELECT json_agg(a.package_id) FROM shipment_package_allocations a WHERE a.shipment_id=s.id) AS package_ids FROM shipments s WHERE s.purchase_order_id=$1 ORDER BY s.created_at`,
          [order.id],
        ),
        pool.query(
          "SELECT stage,review_status,quantity,planned_at,actual_at FROM production_updates WHERE purchase_order_id=$1",
          [order.id],
        ),
        repo.settings(pool),
      ]);
    const today = businessDay(settings.timezone),
      overdue =
        !!order.promised_date &&
        order.promised_date < today &&
        !["shipped", "cancelled"].includes(order.status);
    const approvedStages = [
      ...new Set(
        progress.rows
          .filter((p) => p.review_status === "approved")
          .map((p) => p.stage),
      ),
    ];
    const estimated = (
      await pool.query(
        `SELECT qo.snapshot->'calculation'->'lines' AS lines FROM purchase_orders po JOIN sales_orders so ON so.id=po.sales_order_id JOIN quotation_orders qo ON qo.id=so.quotation_order_id WHERE po.id=$1`,
        [order.id],
      )
    ).rows[0].lines;
    const ownKeys = (
      await pool.query(
        "SELECT si.line_key FROM purchase_order_items pi JOIN sales_order_items si ON si.id=pi.sales_order_item_id WHERE pi.purchase_order_id=$1",
        [order.id],
      )
    ).rows.map((i) => i.line_key);
    const estimate = (
      estimated as { key: string; packed: { cbm: number; grossKg: number } }[]
    )
      .filter((l) => ownKeys.includes(l.key))
      .reduce(
        (s, l) => ({
          cbm: s.cbm + l.packed.cbm,
          grossKg: s.grossKg + l.packed.grossKg,
        }),
        { cbm: 0, grossKg: 0 },
      );
    res.json({
      media: media.rows,
      reworks: reworks.rows,
      packages: packages.rows,
      shipments: shipments.rows,
      progress: {
        approvedStages,
        pending: progress.rows.filter((p) => p.review_status === "pending")
          .length,
        overdue,
        daysOverdue: overdue
          ? Math.round(
              (Date.parse(today) - Date.parse(order.promised_date)) / 864e5,
            )
          : 0,
        openReworks: reworks.rows.filter((r) => r.status !== "closed").length,
      },
      estimate,
    });
  });
  app.post("/api/supply/purchase-orders/:id/updates", async (req, res) =>
    mutate(req, res, async (db) => {
      const order = await purchaseOrder(db, req.actor, id(req), true);
      operator(req.actor);
      active(order);
      const input = z
        .object({
          stage: z.enum(productionStages),
          plannedAt: z.string().datetime().nullable().default(null),
          actualAt: z.string().datetime(),
          quantity: z.number().int().min(0).max(1e6),
          note: z.string().trim().max(3000).default(""),
        })
        .parse(req.body);
      if (input.stage === "shipped")
        throw new HttpError(
          422,
          "出货请使用分批发货流程，不能用生产反馈跳过质检",
        );
      if (input.quantity > (await orderedQuantity(db, order.id)))
        throw new HttpError(422, "反馈数量超过本工厂订单数量");
      const updateId = randomUUID();
      await db.query(
        "INSERT INTO production_updates(id,purchase_order_id,stage,planned_at,actual_at,quantity,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          updateId,
          order.id,
          input.stage,
          input.plannedAt,
          input.actualAt,
          input.quantity,
          input.note,
          req.actor.id,
        ],
      );
      await repo.audit(db, req.actor, "提交生产反馈待审核", updateId, {
        orderId: order.id,
        stage: input.stage,
      });
      return { id: updateId };
    }),
  );
  app.post(
    "/api/supply/purchase-orders/:id/updates/:updateId/review",
    async (req, res) =>
      mutate(req, res, async (db) => {
        const order = await purchaseOrder(db, req.actor, id(req), true);
        reviewer(req.actor);
        active(order);
        const input = reviewSchema.parse(req.body),
          updateId = z.uuid().parse(req.params.updateId);
        const row = (
          await db.query(
            "SELECT * FROM production_updates WHERE id=$1 AND purchase_order_id=$2",
            [updateId, order.id],
          )
        ).rows[0];
        if (!row) throw new HttpError(404, "反馈不存在");
        repo.checkVersion(row, input.version);
        if (row.review_status !== "pending")
          throw new HttpError(409, "该反馈已经审核");
        if (row.created_by === req.actor.id)
          throw new HttpError(403, "不能审核本人提交的反馈");
        if (input.status === "approved") {
          const approved = Number(
            (
              await db.query(
                "SELECT coalesce(sum(quantity),0) AS total FROM production_updates WHERE purchase_order_id=$1 AND stage=$2 AND review_status='approved'",
                [order.id, row.stage],
              )
            ).rows[0].total,
          );
          if (approved + row.quantity > (await orderedQuantity(db, order.id)))
            throw new HttpError(422, "该节点累计审核数量超过订单数量");
        }
        await db.query(
          "UPDATE production_updates SET review_status=$2,review_note=$3,reviewed_by=$4,reviewed_at=now(),version=version+1 WHERE id=$1",
          [row.id, input.status, input.note, req.actor.id],
        );
        await db.query(
          "UPDATE purchase_orders SET status=CASE WHEN status='accepted' AND $2='approved' THEN 'in_production' ELSE status END,version=version+1,updated_at=now() WHERE id=$1",
          [order.id, input.status],
        );
        await repo.audit(db, req.actor, "审核生产反馈", row.id, {
          status: input.status,
          note: input.note,
        });
        return { id: row.id };
      }),
  );
  app.post("/api/supply/purchase-orders/:id/issues", async (req, res) =>
    mutate(req, res, async (db) => {
      const order = await purchaseOrder(db, req.actor, id(req), true);
      operator(req.actor);
      active(order);
      const input = z
          .object({
            severity: z.enum(["low", "medium", "high", "critical"]),
            description: note.min(5),
          })
          .parse(req.body),
        issueId = randomUUID();
      await db.query(
        "INSERT INTO production_issues(id,purchase_order_id,severity,description,raised_by) VALUES($1,$2,$3,$4,$5)",
        [issueId, order.id, input.severity, input.description, req.actor.id],
      );
      await repo.audit(db, req.actor, "提交生产异常", issueId, {
        orderId: order.id,
      });
      return { id: issueId };
    }),
  );
  app.post(
    "/api/supply/purchase-orders/:id/issues/:issueId/resolve",
    async (req, res) =>
      mutate(req, res, async (db) => {
        const order = await purchaseOrder(db, req.actor, id(req), true);
        reviewer(req.actor);
        const input = z.object({ version, resolution: note }).parse(req.body);
        const row = await db.query(
          "UPDATE production_issues SET status='resolved',resolution=$3,resolved_by=$4,resolved_at=now(),version=version+1 WHERE id=$1 AND purchase_order_id=$2 AND version=$5 AND status IN ('open','mitigating') RETURNING id",
          [
            z.uuid().parse(req.params.issueId),
            order.id,
            input.resolution,
            req.actor.id,
            input.version,
          ],
        );
        if (!row.rowCount) throw new HttpError(409, "异常不存在或已处理");
        await repo.audit(db, req.actor, "解决生产异常", row.rows[0].id);
        return { id: row.rows[0].id };
      }),
  );
  app.post("/api/supply/purchase-orders/:id/quality", async (req, res) =>
    mutate(req, res, async (db) => {
      const order = await purchaseOrder(db, req.actor, id(req), true);
      reviewer(req.actor);
      active(order);
      const input = z
        .object({
          status: z.enum(["passed", "failed", "conditional"]),
          note,
          checklist: z
            .array(
              z.object({
                name: z.string().trim().min(1).max(200),
                passed: z.boolean(),
              }),
            )
            .min(1)
            .max(100),
        })
        .parse(req.body);
      if (input.status === "passed" && input.checklist.some((c) => !c.passed))
        throw new HttpError(422, "存在未通过的检查项，不能判定质检通过");
      if (
        input.status === "passed" &&
        (
          await db.query(
            "SELECT 1 FROM rework_tasks WHERE purchase_order_id=$1 AND status<>'closed' LIMIT 1",
            [order.id],
          )
        ).rowCount
      )
        throw new HttpError(422, "先完成返工复核，再进行复检");
      const inspectionId = randomUUID();
      await db.query(
        "INSERT INTO quality_inspections(id,purchase_order_id,status,note,checklist,inspected_by) VALUES($1,$2,$3,$4,$5,$6)",
        [
          inspectionId,
          order.id,
          input.status,
          input.note,
          JSON.stringify(input.checklist),
          req.actor.id,
        ],
      );
      if (input.status === "failed")
        await db.query(
          "INSERT INTO rework_tasks(id,purchase_order_id,inspection_id,description,created_by) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), order.id, inspectionId, input.note, req.actor.id],
        );
      await db.query(
        "UPDATE purchase_orders SET status=$2,updated_at=now(),version=version+1 WHERE id=$1",
        [order.id, input.status === "passed" ? "ready" : "quality_hold"],
      );
      await repo.audit(db, req.actor, "公司质检及返工", inspectionId, {
        orderId: order.id,
        status: input.status,
      });
      return { id: inspectionId };
    }),
  );
  app.post(
    "/api/supply/purchase-orders/:id/reworks/:reworkId/submit",
    async (req, res) =>
      mutate(req, res, async (db) => {
        const order = await purchaseOrder(db, req.actor, id(req), true);
        active(order);
        if (req.actor.role !== "factory")
          throw new HttpError(403, "返工结果由对应工厂账号提交");
        const input = z.object({ version, note }).parse(req.body);
        const row = await db.query(
          "UPDATE rework_tasks SET status='submitted',factory_note=$3,submitted_by=$4,submitted_at=now(),version=version+1 WHERE id=$1 AND purchase_order_id=$2 AND status='open' AND version=$5 RETURNING id",
          [
            z.uuid().parse(req.params.reworkId),
            order.id,
            input.note,
            req.actor.id,
            input.version,
          ],
        );
        if (!row.rowCount) throw new HttpError(409, "返工状态已变化");
        await repo.audit(db, req.actor, "工厂提交返工结果", row.rows[0].id);
        return { id: row.rows[0].id };
      }),
  );
  app.post(
    "/api/supply/purchase-orders/:id/reworks/:reworkId/review",
    async (req, res) =>
      mutate(req, res, async (db) => {
        const order = await purchaseOrder(db, req.actor, id(req), true);
        reviewer(req.actor);
        active(order);
        const input = reviewSchema.parse(req.body);
        const row = await db.query(
          "UPDATE rework_tasks SET status=$3,review_note=$4,reviewed_by=$5,reviewed_at=now(),version=version+1 WHERE id=$1 AND purchase_order_id=$2 AND status='submitted' AND version=$6 RETURNING id",
          [
            z.uuid().parse(req.params.reworkId),
            order.id,
            input.status === "approved" ? "closed" : "open",
            input.note,
            req.actor.id,
            input.version,
          ],
        );
        if (!row.rowCount) throw new HttpError(409, "返工状态已变化");
        await repo.audit(db, req.actor, "复核返工结果", row.rows[0].id, {
          status: input.status,
        });
        return { id: row.rows[0].id };
      }),
  );
  app.post("/api/supply/purchase-orders/:id/packages", async (req, res) =>
    mutate(req, res, async (db) => {
      const order = await purchaseOrder(db, req.actor, id(req), true);
      operator(req.actor);
      active(order);
      const input = packageSchema.parse(req.body);
      for (const item of input.items) {
        const line = (
          await db.query(
            "SELECT quantity FROM purchase_order_items WHERE id=$1 AND purchase_order_id=$2",
            [item.itemId, order.id],
          )
        ).rows[0];
        if (!line) throw new HttpError(404, "包装明细不属于本工厂订单");
        const packed = Number(
          (
            await db.query(
              "SELECT coalesce(sum(quantity),0) AS total FROM shipment_package_items WHERE purchase_order_item_id=$1",
              [item.itemId],
            )
          ).rows[0].total,
        );
        if (packed + item.quantity > line.quantity)
          throw new HttpError(422, "累计包装数量超过产品订单数量");
      }
      const packageId = randomUUID();
      await db.query(
        "INSERT INTO shipment_packages(id,purchase_order_id,label,length_mm,width_mm,height_mm,net_kg,gross_kg,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          packageId,
          order.id,
          input.label,
          input.lengthMm,
          input.widthMm,
          input.heightMm,
          input.netKg,
          input.grossKg,
          input.note,
          req.actor.id,
        ],
      );
      for (const item of input.items)
        await db.query(
          "INSERT INTO shipment_package_items(package_id,purchase_order_item_id,quantity) VALUES($1,$2,$3)",
          [packageId, item.itemId, item.quantity],
        );
      await repo.audit(db, req.actor, "录入最终包装", packageId, {
        orderId: order.id,
      });
      return { id: packageId };
    }),
  );
  app.post("/api/supply/purchase-orders/:id/shipments", async (req, res) =>
    mutate(req, res, async (db) => {
      const order = await purchaseOrder(db, req.actor, id(req), true);
      operator(req.actor);
      active(order);
      const input = shipmentSchema.parse(req.body);
      const packages = await db.query(
        "SELECT id FROM shipment_packages WHERE purchase_order_id=$1 AND id=ANY($2::uuid[])",
        [order.id, input.packageIds],
      );
      if (packages.rowCount !== input.packageIds.length)
        throw new HttpError(404, "存在不属于本工厂订单的包装");
      if (
        (
          await db.query(
            "SELECT 1 FROM shipment_package_allocations WHERE package_id=ANY($1::uuid[]) LIMIT 1",
            [input.packageIds],
          )
        ).rowCount
      )
        throw new HttpError(409, "包装已经分配至其他发货批次");
      const shipmentId = randomUUID(),
        number = `SH-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${shipmentId.slice(0, 8).toUpperCase()}`;
      await db.query(
        "INSERT INTO shipments(id,purchase_order_id,shipment_number,carrier,tracking_number,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          shipmentId,
          order.id,
          number,
          input.carrier,
          input.trackingNumber,
          input.note,
          req.actor.id,
        ],
      );
      for (const packageId of input.packageIds)
        await db.query(
          "INSERT INTO shipment_package_allocations(shipment_id,package_id) VALUES($1,$2)",
          [shipmentId, packageId],
        );
      await repo.audit(db, req.actor, "创建分批发货单", shipmentId, {
        orderId: order.id,
        packages: input.packageIds,
      });
      return { id: shipmentId };
    }),
  );
  app.post(
    "/api/supply/purchase-orders/:id/shipments/:shipmentId/dispatch",
    async (req, res) =>
      mutate(req, res, async (db) => {
        const order = await purchaseOrder(db, req.actor, id(req), true);
        reviewer(req.actor);
        active(order);
        const v = version.parse(req.body.version),
          shipmentId = z.uuid().parse(req.params.shipmentId);
        await shippingReady(db, order.id);
        const qty = Number(
          (
            await db.query(
              "SELECT coalesce(sum(i.quantity),0) AS total FROM shipment_package_allocations a JOIN shipment_package_items i ON i.package_id=a.package_id JOIN shipments s ON s.id=a.shipment_id WHERE a.shipment_id=$1 AND s.purchase_order_id=$2",
              [shipmentId, order.id],
            )
          ).rows[0].total,
        );
        const sent = Number(
          (
            await db.query(
              "SELECT coalesce(sum(i.quantity),0) AS total FROM shipments s JOIN shipment_package_allocations a ON a.shipment_id=s.id JOIN shipment_package_items i ON i.package_id=a.package_id WHERE s.purchase_order_id=$1 AND s.status IN ('dispatched','received')",
              [order.id],
            )
          ).rows[0].total,
        );
        const approved = Number(
          (
            await db.query(
              "SELECT coalesce(sum(quantity),0) AS total FROM production_updates WHERE purchase_order_id=$1 AND stage='packing' AND review_status='approved'",
              [order.id],
            )
          ).rows[0].total,
        );
        if (!qty || sent + qty > approved)
          throw new HttpError(
            422,
            "发货数量超过已审核包装数量，请跟单先审核包装反馈",
          );
        const changed = await db.query(
          "UPDATE shipments SET status='dispatched',dispatched_at=now(),dispatched_by=$4,version=version+1 WHERE id=$1 AND purchase_order_id=$2 AND version=$3 AND status='draft' RETURNING id",
          [shipmentId, order.id, v, req.actor.id],
        );
        if (!changed.rowCount) throw new HttpError(409, "发货单不存在或已发出");
        await syncShipmentState(db, order.id);
        await repo.audit(db, req.actor, "审核并确认分批发货", shipmentId, {
          orderId: order.id,
        });
        return { id: shipmentId };
      }),
  );
  app.post(
    "/api/supply/purchase-orders/:id/shipments/:shipmentId/receive",
    async (req, res) =>
      mutate(req, res, async (db) => {
        const order = await purchaseOrder(db, req.actor, id(req), true);
        reviewer(req.actor);
        const input = z
            .object({ version, evidence: note.min(5) })
            .parse(req.body),
          shipmentId = z.uuid().parse(req.params.shipmentId);
        const row = await db.query(
          "UPDATE shipments SET status='received',received_at=now(),received_by=$4,receipt_evidence=$5,version=version+1 WHERE id=$1 AND purchase_order_id=$2 AND version=$3 AND status='dispatched' RETURNING id",
          [shipmentId, order.id, input.version, req.actor.id, input.evidence],
        );
        if (!row.rowCount)
          throw new HttpError(409, "仅已发货且未签收的批次可登记签收");
        await syncShipmentState(db, order.id);
        await repo.audit(db, req.actor, "核实并记录签收", shipmentId, {
          evidence: input.evidence,
        });
        return { id: shipmentId };
      }),
  );
  app.post("/api/supply/purchase-orders/:id/media", async (req, res) =>
    mutate(req, res, async (db) => {
      const order = await purchaseOrder(db, req.actor, id(req), true);
      operator(req.actor);
      const input = z
        .object({
          updateId: z.uuid(),
          kind: z.enum(["photo", "video", "document"]),
          name: z.string().trim().min(1).max(180),
          mime: z.enum([
            "image/jpeg",
            "image/png",
            "image/webp",
            "video/mp4",
            "application/pdf",
          ]),
          data: z.string().max(11000000),
        })
        .parse(req.body);
      const bytes = Buffer.from(input.data, "base64");
      if (!bytes.length || bytes.length > 8e6)
        throw new HttpError(400, "单个文件不能超过8MB");
      const expected = input.mime.startsWith("image/")
        ? "photo"
        : input.mime === "video/mp4"
          ? "video"
          : "document";
      const matches =
        input.mime === "image/png"
          ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
          : input.mime === "image/jpeg"
            ? bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
            : input.mime === "image/webp"
              ? bytes.subarray(0, 4).toString() === "RIFF" &&
                bytes.subarray(8, 12).toString() === "WEBP"
              : input.mime === "video/mp4"
                ? bytes.subarray(4, 8).toString() === "ftyp"
                : bytes.subarray(0, 5).toString() === "%PDF-";
      if (expected !== input.kind || !matches)
        throw new HttpError(400, "文件内容或类型不匹配");
      const update = (
        await db.query(
          "SELECT created_by,review_status FROM production_updates WHERE id=$1 AND purchase_order_id=$2",
          [input.updateId, order.id],
        )
      ).rows[0];
      if (!update) throw new HttpError(404, "生产节点不存在");
      if (update.review_status !== "pending")
        throw new HttpError(409, "已审核的反馈资料不可修改，请创建新的反馈");
      if (req.actor.role === "factory" && update.created_by !== req.actor.id)
        throw new HttpError(403, "只能给本人提交的反馈添加资料");
      const mediaId = randomUUID();
      await db.query(
        "INSERT INTO production_media(id,purchase_order_id,production_update_id,kind,name,mime,bytes_base64,sha256,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          mediaId,
          order.id,
          input.updateId,
          input.kind,
          input.name,
          input.mime,
          bytes.toString("base64"),
          createHash("sha256").update(bytes).digest("hex"),
          req.actor.id,
        ],
      );
      await repo.audit(db, req.actor, "上传生产反馈资料", mediaId, {
        orderId: order.id,
      });
      return { id: mediaId };
    }),
  );
  app.get("/api/supply/media/:mediaId", async (req, res) => {
    const row = (
      await pool.query("SELECT * FROM production_media WHERE id=$1", [
        z.uuid().parse(req.params.mediaId),
      ])
    ).rows[0];
    if (!row) throw new HttpError(404, "文件不存在");
    await purchaseOrder(pool, req.actor, row.purchase_order_id);
    res
      .set({
        "Content-Type": row.mime,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        "Content-Security-Policy": "sandbox",
      })
      .send(Buffer.from(row.bytes_base64, "base64"));
  });
}
