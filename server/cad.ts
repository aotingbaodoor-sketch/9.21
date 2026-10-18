import type { Express, Request, Response } from "express";
import type pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { tcProject, tcRecord } from "./technical.ts";
import { HttpError } from "./domain.ts";
import * as repo from "./repository.ts";
import { cadWorker, analyzeCad } from "./cad-engine.ts";
import {
  CAD_ENGINE,
  CAD_LIMITATIONS,
  cadParameters,
  cadConflicts,
  cadSvg,
} from "../shared/cad.ts";
import { renderHtmlPdf } from "./supply/manufacturing-export.ts";
import { escapeXml } from "../shared/drawing.ts";
import type { Db } from "./db.ts";
type Mutate = (
  req: Request,
  res: Response,
  fn: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;
const id = z.uuid();
function role(actor: any, review = false) {
  if (
    !(
      review
        ? ["admin", "technical"]
        : ["admin", "sales", "technical", "coordinator"]
    ).includes(actor.role)
  )
    throw new HttpError(403, "无CAD" + (review ? "审核" : "操作") + "权限");
}
async function source(db: Db, actor: any, key: string) {
  role(actor);
  const s = (await db.query("SELECT * FROM cad_sources WHERE id=$1", [key]))
    .rows[0];
  if (!s) throw new HttpError(404, "图纸不存在");
  await tcProject(db, actor, s.project_id);
  return s;
}
async function revision(db: Db, actor: any, key: string) {
  role(actor);
  const v = (await db.query("SELECT * FROM cad_versions WHERE id=$1", [key]))
    .rows[0];
  if (!v) throw new HttpError(404, "深化图不存在");
  await tcProject(db, actor, v.project_id);
  return v;
}
async function current(db: Db, v: any) {
  if (
    (
      await db.query(
        "SELECT 1 FROM cad_sources WHERE project_id=$1 AND created_at>$2",
        [v.project_id, v.created_at],
      )
    ).rowCount
  )
    throw new HttpError(409, "原图已有更新，请重新分析、生成和审核");
  if (
    (
      await db.query(
        "SELECT 1 FROM cad_versions WHERE project_id=$1 AND version>$2",
        [v.project_id, v.version],
      )
    ).rowCount
  )
    throw new HttpError(409, "深化图已有新版，旧版不能继续审核或关联生产");
  const newer = (
    await db.query(
      "SELECT 1 FROM technical_confirmation t JOIN technical_confirmation n ON n.series_id=t.series_id AND n.version>t.version WHERE t.id=$1",
      [v.tc_id],
    )
  ).rowCount;
  if (newer) throw new HttpError(409, "TC已升版，请基于新TC重新生成和审核");
}
export async function requireCadProduction(db: Db, projectId: string) {
  if (
    (
      await db.query(
        "SELECT 1 FROM cad_projects WHERE project_id=$1 AND enabled",
        [projectId],
      )
    ).rowCount
  )
    throw new HttpError(
      409,
      "CAD深化项目尚无公司批准的生产节点模板与生产批准图。当前仅可导出深化草稿；请完成工程深化及生产图验收，不得绕过客户签认、G-44/G-46。",
    );
}
export function registerCad(app: Express, pool: pg.Pool, mutate: Mutate) {
  app.get("/api/supply/cad/projects/:id", async (req, res) => {
    role(req.actor);
    const p = await tcProject(pool, req.actor, id.parse(req.params.id));
    const [sources, versions, tcs] = await Promise.all([
      pool.query(
        `SELECT s.id,s.name,s.format,s.created_at,a.status,a.error FROM cad_sources s LEFT JOIN LATERAL(SELECT status,error FROM cad_analysis WHERE source_id=s.id ORDER BY created_at DESC LIMIT 1)a ON true WHERE s.project_id=$1 ORDER BY s.created_at DESC`,
        [p.id],
      ),
      pool.query(
        `SELECT v.id,v.version,v.tc_id,v.reason,v.issues,v.created_at,r.decision,r.note FROM cad_versions v LEFT JOIN LATERAL(SELECT decision,note FROM cad_reviews WHERE version_id=v.id ORDER BY created_at DESC LIMIT 1)r ON true WHERE v.project_id=$1 ORDER BY version DESC`,
        [p.id],
      ),
      pool.query(
        `SELECT id,tc_no,version,technical FROM technical_confirmation WHERE project_id=$1 ORDER BY version DESC`,
        [p.id],
      ),
    ]);
    res.json({
      project: { id: p.id, name: p.name, customerCode: p.crm_customer_code },
      sources: sources.rows,
      versions: versions.rows,
      tcs: tcs.rows,
      canReview: ["admin", "technical"].includes(req.actor.role),
      limitations: CAD_LIMITATIONS,
    });
  });
  app.post("/api/supply/cad/projects/:id/sources", async (req, res) =>
    mutate(req, res, async (db) => {
      role(req.actor);
      const p = await tcProject(db, req.actor, id.parse(req.params.id));
      if (p.project_closed) throw new HttpError(409, "项目已关闭");
      const b = z
        .object({
          name: z.string().trim().min(1).max(180),
          data: z.string().min(1).max(5700000),
          enableDrafting: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const format = b.name
        .split(".")
        .pop()
        ?.toLowerCase()
        .replace("jpeg", "jpg");
      if (!["dxf", "dwg", "pdf", "png", "jpg"].includes(format || ""))
        throw new HttpError(422, "支持DXF/DWG/PDF/PNG/JPEG");
      const bytes = Buffer.from(b.data, "base64");
      if (bytes.length > 4 * 1024 * 1024)
        throw new HttpError(413, "图纸限4MB，请分图上传");
      if (
        format === "dwg" &&
        !/^AC10\d{2}/.test(bytes.subarray(0, 6).toString())
      )
        throw new HttpError(422, "不是可识别的DWG文件头");
      const sha = createHash("sha256").update(bytes).digest("hex");
      await db.query(
        "INSERT INTO cad_projects(project_id,created_by) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [p.id, req.actor.id],
      );
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "cad-source:" + p.id + sha,
      ]);
      const prior = (
        await db.query(
          "SELECT id FROM cad_sources WHERE project_id=$1 AND sha256=$2",
          [p.id, sha],
        )
      ).rows[0];
      if (prior) return { ...prior, reused: true };
      const key = randomUUID();
      const row = (
        await db.query(
          "INSERT INTO cad_sources(id,project_id,name,format,sha256,original_base64,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
          [key, p.id, b.name, format, sha, b.data, req.actor.id],
        )
      ).rows[0];
      await repo.audit(db, req.actor, "保存CAD内部原件", row.id, {
        projectId: p.id,
      });
      return row;
    }),
  );
  app.get("/api/supply/cad/sources/:id", async (req, res) => {
    const s = await source(pool, req.actor, id.parse(req.params.id));
    const a = (
      await pool.query(
        "SELECT id,status,result,error,created_at FROM cad_analysis WHERE source_id=$1 ORDER BY created_at DESC LIMIT 1",
        [s.id],
      )
    ).rows[0];
    res.json({
      id: s.id,
      projectId: s.project_id,
      name: s.name,
      format: s.format,
      analysis: a || null,
    });
  });
  app.get("/api/supply/cad/sources/:id/download", async (req, res) => {
    const s = await source(pool, req.actor, id.parse(req.params.id));
    res
      .set("Cache-Control", "private, no-store")
      .set(
        "Content-Disposition",
        `attachment; filename="internal-${s.id}.${s.format}"`,
      )
      .type("application/octet-stream")
      .send(Buffer.from(s.original_base64, "base64"));
  });
  app.post("/api/supply/cad/sources/:id/analyze", async (req, res) =>
    mutate(req, res, async (db) => {
      const s = await source(db, req.actor, id.parse(req.params.id));
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "cad-analysis:" + s.id,
      ]);
      const cached = (
        await db.query(
          "SELECT id,status FROM cad_analysis WHERE source_id=$1 AND engine=$2 AND status IN ('analyzed','unsupported') ORDER BY created_at DESC LIMIT 1",
          [s.id, CAD_ENGINE],
        )
      ).rows[0];
      if (cached) return { ...cached, cached: true };
      let result: any = {},
        status = "failed",
        error = null;
      try {
        result = await analyzeCad(
          Buffer.from(s.original_base64, "base64"),
          s.format,
        );
        status = result.status;
      } catch (e) {
        error =
          e instanceof HttpError
            ? e.message
            : "解析失败；原文件与已确认参数保留，可重试";
      }
      const key = randomUUID();
      await db.query(
        "INSERT INTO cad_analysis(id,source_id,engine,status,result,error,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          key,
          s.id,
          CAD_ENGINE,
          status,
          JSON.stringify(result),
          error,
          req.actor.id,
        ],
      );
      return { id: key, status, error };
    }),
  );
  app.post("/api/supply/cad/projects/:id/versions", async (req, res) =>
    mutate(req, res, async (db) => {
      role(req.actor);
      const p = await tcProject(db, req.actor, id.parse(req.params.id));
      if (p.project_closed) throw new HttpError(409, "项目已关闭");
      const b = z
        .object({
          sourceId: id,
          tcId: id,
          baseVersion: z.number().int().min(0),
          parameters: cadParameters,
          reason: z.string().trim().min(1).max(1000),
        })
        .strict()
        .parse(req.body);
      const s = await source(db, req.actor, b.sourceId),
        t = await tcRecord(db, req.actor, b.tcId);
      if (s.project_id !== p.id || t.project_id !== p.id)
        throw new HttpError(422, "原图和TC必须属于同一项目");
      if (t.superseded) throw new HttpError(409, "不能引用旧TC版本");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "cad-project:" + p.id,
      ]);
      const n =
        Number(
          (
            await db.query(
              "SELECT coalesce(max(version),0) n FROM cad_versions WHERE project_id=$1",
              [p.id],
            )
          ).rows[0].n,
        ) + 1;
      if (n !== b.baseVersion + 1)
        throw new HttpError(409, "图纸版本已变化，请刷新");
      if (b.parameters.technical.items.length > 5)
        throw new HttpError(
          422,
          "首批参数化草稿每图最多5项，请分项目/图纸处理",
        );
      for (const item of b.parameters.technical.items)
        if (!b.parameters.details[item.lineKey])
          throw new HttpError(422, item.lineKey + "缺少观察方向及来源位置确认");
      const issues = cadConflicts(t.technical, b.parameters.technical),
        key = randomUUID();
      const generated = await cadWorker("generate", {
        items: b.parameters.technical.items,
        details: b.parameters.details,
        drawingNo: "CAD-" + key.slice(0, 8),
        version: n,
        date: new Date().toISOString().slice(0, 10),
        tcNo: t.tc_no,
        tcVersion: t.version,
        customerCode: p.crm_customer_code || "PENDING",
      });
      await db.query(
        "INSERT INTO cad_versions(id,project_id,source_id,tc_id,version,parameters,technical_snapshot,output,issues,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          key,
          p.id,
          s.id,
          t.id,
          n,
          JSON.stringify(b.parameters),
          JSON.stringify(t.technical),
          JSON.stringify(generated),
          JSON.stringify(issues),
          b.reason,
          req.actor.id,
        ],
      );
      await repo.audit(db, req.actor, "生成可编辑CAD深化草稿", key, {
        tcId: t.id,
        version: n,
        issues,
      });
      return { id: key, version: n };
    }),
  );
  app.get("/api/supply/cad/versions/:id", async (req, res) => {
    const v = await revision(pool, req.actor, id.parse(req.params.id));
    const reviews = (
      await pool.query(
        "SELECT decision,note,created_at,reviewed_by FROM cad_reviews WHERE version_id=$1 ORDER BY created_at DESC",
        [v.id],
      )
    ).rows;
    const previous = (
      await pool.query(
        "SELECT parameters FROM cad_versions WHERE project_id=$1 AND version<$2 ORDER BY version DESC LIMIT 1",
        [v.project_id, v.version],
      )
    ).rows[0];
    const moDrafts = (
      await pool.query(
        "SELECT id,created_at FROM crm_manufacturing_drafts WHERE source_tc_id=$1 ORDER BY created_at DESC",
        [v.tc_id],
      )
    ).rows;
    let staleReason = "";
    try {
      await current(pool, v);
    } catch (e) {
      staleReason = e instanceof Error ? e.message : "版本失效";
    }
    res.json({
      ...v,
      output: { analysis: v.output.analysis },
      reviews,
      moDrafts,
      staleReason,
      previousParameters: previous?.parameters || null,
    });
  });
  app.post("/api/supply/cad/versions/:id/review", async (req, res) =>
    mutate(req, res, async (db) => {
      role(req.actor, true);
      const v = await revision(db, req.actor, id.parse(req.params.id));
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "cad-project:" + v.project_id,
      ]);
      await current(db, v);
      const b = z
        .object({
          decision: z.enum(["approved_draft", "rejected", "withdrawn"]),
          note: z.string().trim().min(1).max(1000),
          dimensionsChecked: z.boolean(),
          privacyChecked: z.boolean(),
        })
        .strict()
        .parse(req.body);
      if (
        b.decision === "approved_draft" &&
        (!b.dimensionsChecked || !b.privacyChecked || v.issues.length)
      )
        throw new HttpError(
          409,
          "请核对全部尺寸和隐私，并解决TC技术差异后再审核",
        );
      await db.query(
        "INSERT INTO cad_reviews(id,version_id,decision,note,reviewed_by) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), v.id, b.decision, b.note, req.actor.id],
      );
      await repo.audit(
        db,
        req.actor,
        "CAD草稿审核（不替代客户签认或生产批准）",
        v.id,
        b,
      );
      return { ok: true };
    }),
  );
  app.post("/api/supply/cad/versions/:id/link-mo", async (req, res) =>
    mutate(req, res, async (db) => {
      role(req.actor, true);
      const v = await revision(db, req.actor, id.parse(req.params.id));
      await current(db, v);
      const b = z.object({ moDraftId: id }).parse(req.body),
        m = (
          await db.query("SELECT * FROM crm_manufacturing_drafts WHERE id=$1", [
            b.moDraftId,
          ])
        ).rows[0];
      const t = await tcRecord(db, req.actor, v.tc_id);
      if (!m || m.source_tc_id !== t.id)
        throw new HttpError(422, "请选择引用同一TC版本的MO草稿");
      if (!t.file_id)
        throw new HttpError(409, "TC未完成真实客户签字，不能关联MO");
      const r = (
        await db.query(
          "SELECT decision FROM cad_reviews WHERE version_id=$1 ORDER BY created_at DESC LIMIT 1",
          [v.id],
        )
      ).rows[0];
      if (r?.decision !== "approved_draft")
        throw new HttpError(409, "先完成技术草稿审核");
      await db.query(
        "INSERT INTO cad_mo_links(id,version_id,mo_draft_id,linked_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [randomUUID(), v.id, m.id, req.actor.id],
      );
      await repo.audit(db, req.actor, "关联MO深化草稿（禁止生产外发）", m.id, {
        cadVersion: v.id,
      });
      return { ok: true };
    }),
  );
  app.get("/api/supply/cad/versions/:id/export/:format", async (req, res) => {
    const v = await revision(pool, req.actor, id.parse(req.params.id));
    const format = z
      .enum(["dxf", "pdf", "svg", "json"])
      .parse(req.params.format);
    const r = (
      await pool.query(
        "SELECT decision FROM cad_reviews WHERE version_id=$1 ORDER BY created_at DESC LIMIT 1",
        [v.id],
      )
    ).rows[0];
    if (r?.decision === "withdrawn")
      throw new HttpError(409, "该版本已撤回，下载已停止");
    res
      .set("Cache-Control", "private, no-store")
      .set(
        "Content-Disposition",
        `attachment; filename="DRAFT-CAD-${v.id}-V${v.version}.${format}"`,
      );
    await repo.audit(pool, req.actor, "下载CAD内部深化草稿", v.id, { format });
    if (format === "dxf")
      return res
        .type("application/dxf")
        .send(Buffer.from(v.output.dxf, "base64"));
    if (format === "json")
      return res.json({
        version: v.version,
        parameters: v.parameters,
        issues: v.issues,
        limitations: CAD_LIMITATIONS,
      });
    const svg = cadSvg(v.output.analysis.primitives);
    if (format === "svg") return res.type("image/svg+xml").send(svg);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A3 landscape;margin:12mm}body{font:12px Arial,'Microsoft YaHei','Noto Sans CJK SC'}img{width:100%;height:210mm;object-fit:contain}h1{font-size:20px}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:5px}</style></head><body><h1>深化草稿 / NOT FOR PRODUCTION · V${v.version}</h1><p>${escapeXml(CAD_LIMITATIONS)}</p><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"><table><tr><th>构件</th><th>外框 mm</th><th>数量</th></tr>${v.parameters.technical.items.map((i: any) => `<tr><td>${escapeXml(i.lineKey)}</td><td>${i.widthMm} × ${i.heightMm}</td><td>${i.quantity}</td></tr>`).join("")}</table><p>模型单位mm，PDF按页面缩放，不可按打印比例量取生产尺寸。</p></body></html>`;
    res.type("pdf").send(await renderHtmlPdf(html));
  });
}
