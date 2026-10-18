import type { Express, Request, Response } from "express";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "./db.ts";
import { HttpError } from "./domain.ts";
import { tcProject, tcRecord, privacy } from "./technical.ts";
import { current } from "./cad.ts";
import { cadWorker } from "./cad-engine.ts";
import { cadSvg, cadConflicts } from "../shared/cad.ts";
import { purchaseOrder } from "./supply/access.ts";
import { renderHtmlPdf } from "./supply/manufacturing-export.ts";
import * as repo from "./repository.ts";
type Mutate = (
  req: Request,
  res: Response,
  run: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;
export async function cadState(db: Db, versionId: string) {
  const e = (
    await db.query(
      "SELECT state FROM cad_lifecycle WHERE version_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
      [versionId],
    )
  ).rows[0];
  if (e) return e.state as string;
  const r = (
    await db.query(
      "SELECT decision FROM cad_reviews WHERE version_id=$1 ORDER BY created_at DESC LIMIT 1",
      [versionId],
    )
  ).rows[0];
  return r?.decision === "withdrawn"
    ? "void"
    : r?.decision === "approved_draft"
      ? "reviewed"
      : "draft";
}
async function packet(db: Db, versionId: string) {
  return (
    await db.query(
      "SELECT * FROM cad_production_packets WHERE version_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
      [versionId],
    )
  ).rows[0];
}
async function checked(db: Db, actor: any, key: string) {
  if (!["admin", "technical", "sales", "coordinator"].includes(actor.role))
    throw new HttpError(403, "无CAD操作权限");
  const v = (
    await db.query("SELECT * FROM cad_versions WHERE id=$1", [
      z.uuid().parse(key),
    ])
  ).rows[0];
  if (!v) throw new HttpError(404, "图纸不存在");
  const p = await tcProject(db, actor, v.project_id);
  if (p.project_closed) throw new HttpError(409, "项目已关闭");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "cad-project:" + v.project_id,
  ]);
  await current(db, v);
  return v;
}
async function transition(
  db: Db,
  actor: any,
  v: any,
  state: string,
  note: string,
) {
  await db.query(
    "INSERT INTO cad_lifecycle(id,version_id,state,note,actor_id) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), v.id, state, note, actor.id],
  );
  await repo.audit(db, actor, "CAD状态变更", v.id, { state, note });
}
export async function requireProductionDrawing(
  db: Db,
  projectId: string,
  tcId?: string,
  draftId?: string,
) {
  // Same project lock as upload/generation/revocation; prevents a concurrent release race.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "cad-project:" + projectId,
  ]);
  const v = (
    await db.query(
      "SELECT v.* FROM cad_mo_links l JOIN cad_versions v ON v.id=l.version_id WHERE l.mo_draft_id=$1 AND v.project_id=$2 AND v.tc_id=$3 ORDER BY v.version DESC LIMIT 1",
      [draftId || null, projectId, tcId || null],
    )
  ).rows[0];
  if (!v)
    throw new HttpError(
      409,
      "CAD深化项目缺少本MO、本TC版本的生产批准图。请到CAD页面补齐生产资料、审核及批准后关联。",
    );
  await current(db, v);
  if ((await cadState(db, v.id)) !== "production_approved")
    throw new HttpError(409, "生产图未批准或批准已撤回；请重新审核批准");
  const p = await packet(db, v.id);
  if (!p) throw new HttpError(409, "生产图资料包缺失");
  return { v, p };
}
export function registerCadRelease(
  app: Express,
  pool: pg.Pool,
  mutate: Mutate,
) {
  app.get("/api/supply/cad/versions/:id/release", async (req, res) => {
    const v = (
      await pool.query("SELECT * FROM cad_versions WHERE id=$1", [
        z.uuid().parse(req.params.id),
      ])
    ).rows[0];
    if (!v) throw new HttpError(404, "图纸不存在");
    await tcProject(pool, req.actor, v.project_id);
    const p = await packet(pool, v.id);
    res.json({
      state: await cadState(pool, v.id),
      packet: p
        ? {
            id: p.id,
            technical_report: p.technical_report,
            created_at: p.created_at,
            analysis: p.output.analysis,
          }
        : null,
      sources: (
        await pool.query(
          "SELECT id,name,format FROM cad_sources WHERE project_id=$1 ORDER BY created_at DESC",
          [v.project_id],
        )
      ).rows,
      history: (
        await pool.query(
          "SELECT e.state,e.note,e.created_at,u.name FROM cad_lifecycle e JOIN users u ON u.id=e.actor_id WHERE e.version_id=$1 ORDER BY e.created_at DESC",
          [v.id],
        )
      ).rows,
      canReview: ["admin", "technical"].includes(req.actor.role),
      canApprove: req.actor.role === "admin",
    });
  });
  app.post("/api/supply/cad/versions/:id/submit", async (req, res) =>
    mutate(req, res, async (db) => {
      const v = await checked(db, req.actor, req.params.id as string);
      if (!["draft", "reviewed"].includes(await cadState(db, v.id)))
        throw new HttpError(409, "当前状态不能提交，请先撤回或创建新版本");
      if (v.issues.length)
        throw new HttpError(409, "请先处理TC技术差异，再提交审核");
      await transition(db, req.actor, v, "submitted", "提交技术审核");
      return { ok: true };
    }),
  );
  app.post("/api/supply/cad/versions/:id/production-packet", async (req, res) =>
    mutate(req, res, async (db) => {
      if (!["admin", "technical"].includes(req.actor.role))
        throw new HttpError(403, "生产资料只能由技术人员或管理员提交");
      const v = await checked(db, req.actor, req.params.id as string);
      if (["void", "production_approved"].includes(await cadState(db, v.id)))
        throw new HttpError(409, "已批准/作废版本不能修改资料，请新建版本");
      const b = z
        .object({
          drawingSourceId: z.uuid(),
          profileSourceId: z.uuid(),
          nodeSourceId: z.uuid(),
          toleranceSourceId: z.uuid(),
          inspectionSourceId: z.uuid(),
          report: z
            .array(
              z
                .object({
                  lineKey: z.string(),
                  widthEntityId: z.string().min(1),
                  heightEntityId: z.string().min(1),
                  drawingEvidence: z.string().trim().min(3).max(500),
                  dimensions: z.literal(true),
                  materials: z.literal(true),
                  quantity: z.literal(true),
                  configuration: z.literal(true),
                })
                .strict(),
            )
            .min(1)
            .max(5),
          note: z.string().trim().min(10).max(2000),
        })
        .strict()
        .parse(req.body);
      const keys = [
        b.drawingSourceId,
        b.profileSourceId,
        b.nodeSourceId,
        b.toleranceSourceId,
        b.inspectionSourceId,
      ];
      const sources = (
        await db.query(
          "SELECT * FROM cad_sources WHERE id=ANY($1::uuid[]) AND project_id=$2",
          [keys, v.project_id],
        )
      ).rows;
      if (keys.some((k) => !sources.some((s) => s.id === k)))
        throw new HttpError(
          422,
          "完成图、型材、节点、公差和CAD独立验收凭据必须为本项目已上传文件",
        );
      const drawing = sources.find((s) => s.id === b.drawingSourceId);
      if (drawing.format !== "dxf")
        throw new HttpError(
          422,
          "生产完成图请提交实际可编辑DXF；不直接发布未核准DWG转换结果",
        );
      if (b.drawingSourceId === b.inspectionSourceId)
        throw new HttpError(422, "独立CAD验收记录须为单独的PDF或图片凭据");
      if (
        !["pdf", "png", "jpg"].includes(
          sources.find((s) => s.id === b.inspectionSourceId).format,
        )
      )
        throw new HttpError(422, "独立CAD验收凭据须为PDF或图片");
      const lines = v.parameters.technical.items.map((i: any) => i.lineKey);
      if (
        b.report.length !== lines.length ||
        new Set(b.report.map((r) => r.lineKey)).size !== lines.length ||
        lines.some((k: string) => !b.report.some((r) => r.lineKey === k))
      )
        throw new HttpError(
          422,
          "必须逐构件记录尺寸、材料、数量、配置与生产图实体定位依据",
        );
      const t = await tcRecord(db, req.actor, v.tc_id);
      if (cadConflicts(t.technical, v.parameters.technical).length)
        throw new HttpError(409, "TC存在技术差异");
      const measured = await cadWorker("analyze", drawing.original_base64);
      for (const item of v.parameters.technical.items) {
        const check = b.report.find((r) => r.lineKey === item.lineKey)!;
        for (const [key, value] of [
          [check.widthEntityId, item.widthMm],
          [check.heightEntityId, item.heightMm],
        ]) {
          const e = measured.entities.find(
            (r: any) => r.id === key && r.type === "DIMENSION",
          );
          if (
            !e ||
            !Number.isFinite(e.measurement) ||
            Math.abs(e.measurement - Number(value)) > 0.01
          )
            throw new HttpError(
              409,
              item.lineKey +
                "：引用尺寸标注实体与TC毫米尺寸不一致；请在完成DXF分析中选择正确实体",
            );
        }
      }
      const project=await tcProject(db,req.actor,v.project_id);
      if(!/^[A-Z]\d{12}$/.test(project.crm_customer_code||''))throw new HttpError(409,'客户编号未符合13位规则，请先处理客户编码；不自动重编历史编号');
      const output = await cadWorker("factory", {raw:drawing.original_base64,stamp:[`CUSTOMER CODE: ${project.crm_customer_code}`,`CAD-${v.id} / V${v.version}`,`${t.tc_no} / TC V${t.version} / UNIT mm`]});
      // Scan all reconstructed entity text; no original names, metadata, XREF or embedded images survive.
      await privacy(
        db,
        t,
        output.analysis.entities.map((e: any) => e.text || ""),
      );
      if (output.analysis.units !== 4)
        throw new HttpError(422, "生产完成图必须明确使用毫米");
      await db.query(
        "INSERT INTO cad_production_packets(id,version_id,drawing_source_id,profile_source_id,node_source_id,tolerance_source_id,inspection_source_id,technical_report,output,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          randomUUID(),
          v.id,
          ...keys,
          JSON.stringify({ lines: b.report, note: b.note }),
          JSON.stringify(output),
          req.actor.id,
        ],
      );
      await transition(
        db,
        req.actor,
        v,
        "draft",
        "生产资料已更新，原审核失效，必须重新提交审核",
      );
      return { ok: true };
    }),
  );
  app.post(
    "/api/supply/cad/versions/:id/approve-production",
    async (req, res) =>
      mutate(req, res, async (db) => {
        if (req.actor.role !== "admin")
          throw new HttpError(
            403,
            "生产批准仅管理员可执行；技术审核不等于生产批准",
          );
        const v = await checked(db, req.actor, req.params.id as string);
        const note = z
          .object({ note: z.string().trim().min(10).max(2000) })
          .strict()
          .parse(req.body).note;
        if ((await cadState(db, v.id)) !== "reviewed")
          throw new HttpError(409, "请先完成技术审核");
        if (!(await packet(db, v.id)))
          throw new HttpError(
            409,
            "缺少生产完成DXF、公司型材/节点/公差依据或独立CAD验收记录。当前自动生成的外框草稿不可批准生产。",
          );
        const t = await tcRecord(db, req.actor, v.tc_id);
        if (!t.file_id)
          throw new HttpError(
            409,
            "当前TC版本缺少真实客户签字凭据；技术审核不能替代客户确认",
          );
        if (v.issues.length) throw new HttpError(409, "TC技术差异未解决");
        await transition(db, req.actor, v, "production_approved", note);
        return { ok: true };
      }),
  );
  // Revocation is allowed even after a new version/TC: it must not be blocked by staleness.
  app.post("/api/supply/cad/versions/:id/void", async (req, res) =>
    mutate(req, res, async (db) => {
      if (!["admin", "technical"].includes(req.actor.role))
        throw new HttpError(403, "无撤回批准权限");
      const v = (
        await db.query("SELECT * FROM cad_versions WHERE id=$1", [
          z.uuid().parse(req.params.id),
        ])
      ).rows[0];
      if (!v) throw new HttpError(404, "图纸不存在");
      await tcProject(db, req.actor, v.project_id);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "cad-project:" + v.project_id,
      ]);
      const note = z
        .object({ note: z.string().trim().min(1).max(2000) })
        .parse(req.body).note;
      await transition(db, req.actor, v, "void", note);
      return { ok: true };
    }),
  );
  app.get("/api/supply/cad/versions/:id/approved/:format", async (req, res) => {
    const v = (
      await pool.query("SELECT * FROM cad_versions WHERE id=$1", [
        z.uuid().parse(req.params.id),
      ])
    ).rows[0];
    if (!v) throw new HttpError(404, "图纸不存在");
    await tcProject(pool, req.actor, v.project_id);
    await current(pool, v);
    if ((await cadState(pool, v.id)) !== "production_approved")
      throw new HttpError(409, "生产批准已失效或未批准，禁止下载");
    const p = await packet(pool, v.id);
    await send(res, p, v, req.params.format as string);
  });
  app.get(
    "/api/supply/cad/versions/:id/packet-preview/:format",
    async (req, res) => {
      if (!["admin", "technical"].includes(req.actor.role))
        throw new HttpError(403, "仅技术审核人员可预览未批准的生产资料");
      const v = (
        await pool.query("SELECT * FROM cad_versions WHERE id=$1", [
          z.uuid().parse(req.params.id),
        ])
      ).rows[0];
      if (!v) throw new HttpError(404, "图纸不存在");
      await tcProject(pool, req.actor, v.project_id);
      await current(pool, v);
      if ((await cadState(pool, v.id)) === "void")
        throw new HttpError(409, "版本已作废");
      await send(
        res,
        await packet(pool, v.id),
        v,
        req.params.format as string,
        true,
      );
    },
  );
  app.get(
    "/api/supply/cad/manufacturing/:id/download/:format",
    async (req, res) => {
      const m = (
        await pool.query(
          "SELECT m.*,t.project_id FROM crm_manufacturing_orders m JOIN technical_confirmation t ON t.id=m.source_tc_id WHERE m.id=$1",
          [z.uuid().parse(req.params.id)],
        )
      ).rows[0];
      if (!m) throw new HttpError(404, "生产单不存在");
      await purchaseOrder(pool, req.actor, m.purchase_order_id);
      const { v, p } = await requireProductionDrawing(
        pool,
        m.project_id,
        m.source_tc_id,
        m.draft_id,
      );
      await repo.audit(pool, req.actor, "下载MO生产批准图", m.id, {
        version: v.id,
      });
      await send(res, p, v, req.params.format as string);
    },
  );
}
async function send(
  res: Response,
  p: any,
  v: any,
  format: string,
  draft = false,
) {
  z.enum(["dxf", "pdf"]).parse(format);
  if (!p) throw new HttpError(409, "生产资料包不存在");
  res
    .set("Cache-Control", "private, no-store")
    .set(
      "Content-Disposition",
      `attachment; filename="${draft ? "REVIEW-ONLY-" : ""}CAD-${v.id}-V${v.version}.${format}"`,
    );
  if (format === "dxf")
    return res
      .type("application/dxf")
      .send(
        Buffer.from(
          draft
            ? (await cadWorker("review_copy", p.output.dxf)).dxf
            : p.output.dxf,
          "base64",
        ),
      );
  const svg = cadSvg(p.output.analysis.primitives);
  return res
    .type("pdf")
    .send(
      await renderHtmlPdf(
        `<!doctype html><meta charset="utf-8"><style>@page{size:A3 landscape;margin:12mm}img{width:100%;height:240mm;object-fit:contain}</style><h1>${draft ? "待审核 / 禁止投产" : "生产批准图"} / V${v.version}</h1><p>CAD-${v.id} · mm · PDF不可按打印比例量取尺寸</p><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">`,
      ),
    );
}
