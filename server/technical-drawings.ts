import { randomUUID, createHash } from "node:crypto";
import type { Express, Request, Response } from "express";
import type pg from "pg";
import { z } from "zod";
import type { Db } from "./db.ts";
import type { User } from "../shared/contracts.ts";
import { HttpError } from "./domain.ts";
import { tcRecord, safeManufacturing } from "./technical.ts";
import { workOrder } from "./supply/chain.ts";
import { purchaseOrder } from "./supply/access.ts";
import * as repo from "./repository.ts";
import {
  rasterOriginal,
  redactPages,
  rasterPdf,
  type RasterPage,
} from "./drawing-raster.ts";
type Mutate = (
  req: Request,
  res: Response,
  fn: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;
const uuid = z.uuid(),
  hash = (v: unknown) =>
    createHash("sha256")
      .update(typeof v === "string" ? v : JSON.stringify(v))
      .digest("hex");
const masksSchema = z
  .array(
    z
      .object({
        page: z.number().int().min(0).max(4),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().positive().max(1),
        height: z.number().positive().max(1),
      })
      .strict()
      .refine(
        (m) => m.x + m.width <= 1.000001 && m.y + m.height <= 1.000001,
        "遮盖区域超出页面",
      ),
  )
  .max(200);
async function source(db: Db, actor: User, id: string) {
  const d = (
    await db.query("SELECT * FROM technical_drawings WHERE id=$1", [id])
  ).rows[0];
  if (!d) throw new HttpError(404, "图纸不存在或未授权");
  const tc = await tcRecord(db, actor, d.tc_id);
  return { d, tc };
}
async function lock(db: Db, tc: any) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "tc:" + tc.series_id,
  ]);
}
function reviewRole(actor: User) {
  if (!["admin", "technical"].includes(actor.role))
    throw new HttpError(403, "仅项目授权技术人员或管理员可审核和关联脱敏图纸");
}
export async function latestTcDrawings(db: Db, tcId: string, keys: string[]) {
  const records = (
    await db.query(
      `SELECT d.id drawing_id,d.line_keys,r.id redaction_id,r.version,r.pages,v.approved FROM technical_drawings d LEFT JOIN LATERAL(SELECT * FROM technical_drawing_redactions WHERE drawing_id=d.id ORDER BY version DESC LIMIT 1)r ON true LEFT JOIN technical_drawing_reviews v ON v.redaction_id=r.id WHERE d.tc_id=$1 ORDER BY d.created_at,d.id`,
      [tcId],
    )
  ).rows.filter((r) => r.line_keys.some((k: string) => keys.includes(k)));
  for (const d of records)
    if (!d.redaction_id || !d.approved)
      throw new HttpError(
        409,
        "G-46：TC关联图纸尚未完成脱敏审核；请到TC详情→图纸脱敏审核处理",
      );
  return records;
}
export async function linkTcDrawings(
  db: Db,
  moId: string,
  tcId: string,
  keys: string[],
  actorId: string,
) {
  for (const d of await latestTcDrawings(db, tcId, keys))
    await db.query(
      "INSERT INTO technical_mo_drawings(id,mo_id,redaction_id,linked_by) VALUES($1,$2,$3,$4) ON CONFLICT(mo_id,redaction_id) DO NOTHING",
      [randomUUID(), moId, d.redaction_id, actorId],
    );
}
export async function moDrawingPages(db: Db, m: any) {
  const latest = await latestTcDrawings(
    db,
    m.source_tc_id,
    m.technical_snapshot.tcTechnical.items.map((i: any) => i.lineKey),
  );
  const linked = (
    await db.query(
      "SELECT redaction_id FROM technical_mo_drawings WHERE mo_id=$1",
      [m.id],
    )
  ).rows;
  for (const d of latest)
    if (!linked.some((r) => r.redaction_id === d.redaction_id))
      throw new HttpError(
        409,
        "G-46：图纸有新版本，须审核后在MO页面重新关联；旧链接及导出暂停",
      );
  return latest.map((d, index) => ({
    id: d.redaction_id,
    label: `生产图纸${index + 1} V${d.version}`,
    version: d.version,
    pages: d.pages as RasterPage[],
  }));
}
async function mo(db: Db, actor: User, id: string) {
  const m = (
    await db.query("SELECT * FROM crm_manufacturing_orders WHERE id=$1", [id])
  ).rows[0];
  if (!m) throw new HttpError(404, "MO不存在或未授权");
  if (actor.role === "factory")
    await purchaseOrder(db, actor, m.purchase_order_id);
  else await workOrder(db, actor, m.work_order_id);
  const safe = await safeManufacturing(db, m);
  if (safe.changeRequired)
    throw new HttpError(409, "源TC已升版，请先完成生产变更；图纸下载暂停");
  return m;
}
export function registerTechnicalDrawings(
  app: Express,
  pool: pg.Pool,
  mutate: Mutate,
) {
  app.get("/api/supply/technical/:id/drawings", async (req, res) => {
    const tc = await tcRecord(pool, req.actor, uuid.parse(req.params.id));
    const rows = (
      await pool.query(
        `SELECT d.id,d.name,d.line_keys,d.created_at,jsonb_array_length(d.pages) page_count,r.id redaction_id,r.version,v.approved,v.reviewed_at,u.name reviewer FROM technical_drawings d LEFT JOIN LATERAL(SELECT * FROM technical_drawing_redactions WHERE drawing_id=d.id ORDER BY version DESC LIMIT 1)r ON true LEFT JOIN technical_drawing_reviews v ON v.redaction_id=r.id LEFT JOIN users u ON u.id=v.reviewed_by WHERE d.tc_id=$1 ORDER BY d.created_at`,
        [tc.id],
      )
    ).rows;
    res.json({
      rows,
      canUpload: !tc.file_id && !tc.superseded,
      canReview: ["admin", "technical"].includes(req.actor.role),
    });
  });
  app.post("/api/supply/technical/:id/drawings", async (req, res) =>
    mutate(req, res, async (db) => {
      const tc = await tcRecord(db, req.actor, uuid.parse(req.params.id));
      await lock(db, tc);
      if (
        (
          await db.query(
            "SELECT 1 FROM technical_confirmation_signatures WHERE tc_id=$1",
            [tc.id],
          )
        ).rowCount ||
        (
          await db.query(
            "SELECT 1 FROM technical_confirmation WHERE series_id=$1 AND version>$2",
            [tc.series_id, tc.version],
          )
        ).rowCount
      )
        throw new HttpError(
          409,
          "TC已签字或升版；更改原图必须创建新TC版本并重新签字",
        );
      const b = z
        .object({
          name: z.string().trim().min(1).max(180),
          mime: z.enum(["application/pdf", "image/png", "image/jpeg"]),
          data: z.string().min(1).max(5700000),
          lineKeys: z.array(z.string()).min(1).max(100),
        })
        .strict()
        .parse(req.body);
      if (
        b.lineKeys.some(
          (k) => !tc.technical.items.some((i: any) => i.lineKey === k),
        )
      )
        throw new HttpError(422, "图纸必须关联本TC实际产品行");
      const bytes = Buffer.from(b.data, "base64"),
        pages = await rasterOriginal(bytes, b.mime),
        id = randomUUID();
      await db.query(
        "INSERT INTO technical_drawings(id,tc_id,line_keys,name,mime,original_base64,sha256,pages,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          tc.id,
          JSON.stringify([...new Set(b.lineKeys)]),
          b.name,
          b.mime,
          bytes.toString("base64"),
          hash(bytes.toString("base64")),
          JSON.stringify(pages),
          req.actor.id,
        ],
      );
      await repo.audit(db, req.actor, "上传TC内部原图", id, {
        tcId: tc.id,
        pages: pages.length,
      });
      return { id };
    }),
  );
  app.get("/api/supply/technical-drawings/:id", async (req, res) => {
    const { d, tc } = await source(pool, req.actor, uuid.parse(req.params.id));
    const versions = (
      await pool.query(
        `SELECT r.id,r.version,r.rectangles,r.reason,r.created_at,r.created_by,v.approved,v.reviewed_at,v.note,u.name reviewer FROM technical_drawing_redactions r LEFT JOIN technical_drawing_reviews v ON v.redaction_id=r.id LEFT JOIN users u ON u.id=v.reviewed_by WHERE r.drawing_id=$1 ORDER BY r.version DESC`,
        [d.id],
      )
    ).rows;
    res.json({
      id: d.id,
      tcId: d.tc_id,
      name: d.name,
      lineKeys: d.line_keys,
      pages: d.pages.map((p: RasterPage) => ({
        width: p.width,
        height: p.height,
      })),
      versions,
      superseded: tc.superseded,
      canReview: ["admin", "technical"].includes(req.actor.role),
    });
  });
  app.get(
    [
      "/api/supply/technical-drawings/:id/original",
      "/api/supply/technical-drawings/:id/pages/:page",
    ],
    async (req, res) => {
      const { d } = await source(pool, req.actor, uuid.parse(req.params.id));
      res.set("Cache-Control", "private, no-store");
      if (req.params.page !== undefined) {
        const p =
          d.pages[z.coerce.number().int().min(0).parse(req.params.page)];
        if (!p) throw new HttpError(404, "图纸页不存在");
        res.type("png").send(Buffer.from(p.png, "base64"));
      } else
        res
          .set(
            "Content-Disposition",
            `attachment; filename="internal-${d.id}.${d.mime === "application/pdf" ? "pdf" : d.mime === "image/png" ? "png" : "jpg"}"`,
          )
          .type(d.mime)
          .send(Buffer.from(d.original_base64, "base64"));
    },
  );
  app.post("/api/supply/technical-drawings/:id/redactions", async (req, res) =>
    mutate(req, res, async (db) => {
      const { d, tc } = await source(db, req.actor, uuid.parse(req.params.id));
      await lock(db, tc);
      if (
        (
          await db.query(
            "SELECT 1 FROM technical_confirmation WHERE series_id=$1 AND version>$2",
            [tc.series_id, tc.version],
          )
        ).rowCount
      )
        throw new HttpError(409, "源TC已升版，请处理新TC图纸");
      const b = z
          .object({
            baseVersion: z.number().int().min(0),
            rectangles: masksSchema,
            reason: z.string().trim().min(1).max(500),
          })
          .strict()
          .parse(req.body),
        version =
          Number(
            (
              await db.query(
                "SELECT coalesce(max(version),0) n FROM technical_drawing_redactions WHERE drawing_id=$1",
                [d.id],
              )
            ).rows[0].n,
          ) + 1;
      if (version !== b.baseVersion + 1)
        throw new HttpError(409, "副本已更新，请刷新最新版");
      if (b.rectangles.some((m) => m.page >= d.pages.length))
        throw new HttpError(422, "遮盖页不存在");
      const pages = await redactPages(d.pages, b.rectangles),
        id = randomUUID();
      await db.query(
        "INSERT INTO technical_drawing_redactions(id,drawing_id,version,rectangles,pages,sha256,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          d.id,
          version,
          JSON.stringify(b.rectangles),
          JSON.stringify(pages),
          hash(pages),
          b.reason,
          req.actor.id,
        ],
      );
      await repo.audit(db, req.actor, "生成待审脱敏图纸", id, {
        drawingId: d.id,
        version,
      });
      return { id, version };
    }),
  );
  app.get(
    "/api/supply/drawing-redactions/:id/pages/:page",
    async (req, res) => {
      const r = (
        await pool.query(
          "SELECT * FROM technical_drawing_redactions WHERE id=$1",
          [uuid.parse(req.params.id)],
        )
      ).rows[0];
      if (!r) throw new HttpError(404, "副本不存在");
      await source(pool, req.actor, r.drawing_id);
      const p = r.pages[z.coerce.number().int().min(0).parse(req.params.page)];
      if (!p) throw new HttpError(404, "图纸页不存在");
      res
        .set("Cache-Control", "private, no-store")
        .type("png")
        .send(Buffer.from(p.png, "base64"));
    },
  );
  app.post("/api/supply/drawing-redactions/:id/review", async (req, res) =>
    mutate(req, res, async (db) => {
      reviewRole(req.actor);
      const r = (
        await db.query(
          "SELECT * FROM technical_drawing_redactions WHERE id=$1",
          [uuid.parse(req.params.id)],
        )
      ).rows[0];
      if (!r) throw new HttpError(404, "副本不存在");
      const { tc } = await source(db, req.actor, r.drawing_id);
      await lock(db, tc);
      if (
        (
          await db.query(
            "SELECT 1 FROM technical_drawing_redactions WHERE drawing_id=$1 AND version>$2",
            [r.drawing_id, r.version],
          )
        ).rowCount ||
        (
          await db.query(
            "SELECT 1 FROM technical_confirmation WHERE series_id=$1 AND version>$2",
            [tc.series_id, tc.version],
          )
        ).rowCount
      )
        throw new HttpError(409, "只可审核当前TC的最新图纸副本");
      const b = z
        .object({
          approved: z.boolean(),
          note: z.string().trim().min(1).max(500),
          reviewedPages: z.array(z.number().int().min(0)),
          privacyRemoved: z.boolean(),
          technicalPreserved: z.boolean(),
        })
        .strict()
        .parse(req.body);
      if (
        b.approved &&
        (!b.privacyRemoved ||
          !b.technicalPreserved ||
          new Set(b.reviewedPages).size !== r.pages.length ||
          b.reviewedPages.some((i) => i >= r.pages.length))
      )
        throw new HttpError(
          422,
          "通过审核须逐页核对隐私已去除且尺寸、结构及技术要求完整保留",
        );
      if (
        (
          await db.query(
            "SELECT 1 FROM technical_drawing_reviews WHERE redaction_id=$1",
            [r.id],
          )
        ).rowCount
      )
        throw new HttpError(409, "已审记录不可改写，请生成新副本再审核");
      await db.query(
        "INSERT INTO technical_drawing_reviews(redaction_id,approved,reviewed_by,note,checks) VALUES($1,$2,$3,$4,$5)",
        [
          r.id,
          b.approved,
          req.actor.id,
          b.note,
          JSON.stringify({
            reviewedPages: b.reviewedPages,
            privacyRemoved: b.privacyRemoved,
            technicalPreserved: b.technicalPreserved,
          }),
        ],
      );
      await repo.audit(
        db,
        req.actor,
        b.approved ? "审核通过脱敏图纸" : "驳回脱敏图纸",
        r.id,
        { version: r.version },
      );
      return { ok: true };
    }),
  );
  app.post("/api/supply/manufacturing/:id/drawings/link", async (req, res) =>
    mutate(req, res, async (db) => {
      reviewRole(req.actor);
      const m = await mo(db, req.actor, uuid.parse(req.params.id)),
        tc = await tcRecord(db, req.actor, m.source_tc_id);
      await lock(db, tc);
      await mo(db, req.actor, m.id);
      await linkTcDrawings(
        db,
        m.id,
        m.source_tc_id,
        m.technical_snapshot.tcTechnical.items.map((i: any) => i.lineKey),
        req.actor.id,
      );
      await repo.audit(db, req.actor, "MO关联最新已审图纸版本", m.id);
      return { ok: true };
    }),
  );
  app.get(
    "/api/supply/manufacturing/:id/drawings/:redaction/download",
    async (req, res) => {
      const m = await mo(pool, req.actor, uuid.parse(req.params.id)),
        drawings = await moDrawingPages(pool, m),
        r = drawings.find((d) => d.id === uuid.parse(req.params.redaction));
      if (!r) throw new HttpError(404, "附件不属于本MO的当前已审核版本");
      await repo.audit(pool, req.actor, "下载已审核工厂图纸", m.id, {
        redactionId: r.id,
      });
      res
        .set("Cache-Control", "private, no-store")
        .set(
          "Content-Disposition",
          `attachment; filename="MO-drawing-${r.id}-V${r.version}.pdf"`,
        )
        .type("pdf")
        .send(await rasterPdf(r.pages));
    },
  );
}
