import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { Decimal } from "decimal.js";
import type { Db } from "./db.ts";
import type { User } from "../shared/contracts.ts";
import {
  tcTechnicalSchema,
  tcBusinessSchema,
  productionSchema,
  selectBatch,
  technicalDifferences,
} from "../shared/technical.ts";
import { HttpError, requireAdmin, businessDay } from "./domain.ts";
import { isCustomerCode } from "./coding-contract.ts";
import { registerDocumentInTransaction } from "./document-registry.ts";
import * as repo from "./repository.ts";
import { workOrder, factorySafe } from "./supply/chain.ts";
import { purchaseOrder } from "./supply/access.ts";
import { orderWorkflow } from "./supply/order-workflow.ts";
import { requireProductionInstruction } from "./supply/order-policy.ts";
import { technicalHtml, renderHtmlPdf } from "./supply/manufacturing-export.ts";
import { escapeXml as escape } from "../shared/drawing.ts";
import {latestTcDrawings,linkTcDrawings} from './technical-drawings.ts';
import {rasterPdf} from './drawing-raster.ts';
type Mutate = (
  req: Request,
  res: Response,
  run: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;
const uid = z.uuid();
const projectScope = `($2='admin' OR ($2='sales' AND c.owner_id=$3 AND NOT c.wa_needs_assignment) OR ($2 IN ('technical','coordinator') AND (EXISTS(SELECT 1 FROM quotation_reviews r JOIN quotation_versions q ON q.id=r.quote_id WHERE q.project_id=p.id AND r.assigned_to=$3) OR EXISTS(SELECT 1 FROM crm_work_orders w JOIN sales_orders so ON so.id=w.sales_order_id JOIN quotation_orders qo ON qo.id=so.quotation_order_id WHERE qo.project_id=p.id AND w.scm_owner=$3))))`;
const projectClosed=`EXISTS(SELECT 1 FROM quotation_orders qo JOIN sales_orders so ON so.quotation_order_id=qo.id LEFT JOIN crm_work_orders w ON w.sales_order_id=so.id LEFT JOIN crm_work_order_close wc ON wc.work_order_id=w.id WHERE qo.project_id=p.id AND (so.status IN ('closed','cancelled') OR wc.work_order_id IS NOT NULL))`;
export async function tcProject(db: Db, actor: User, projectId: string) {
  const p = (
    await db.query(
      `SELECT p.*,c.crm_customer_code,c.company,c.data customer_data,${projectClosed} project_closed FROM quotation_projects p JOIN customers c ON c.id=p.customer_id WHERE p.id=$1 AND c.deleted_at IS NULL AND ${projectScope}`,
      [projectId, actor.role, actor.id],
    )
  ).rows[0];
  if (!p) throw new HttpError(404, "TC项目不存在或未授权");
  return p;
}
export async function tcRecord(db: Db, actor: User, id: string) {
  const t = (
    await db.query(
      `SELECT t.*,s.signer_name,s.signed_on,s.file_id,s.verified_at,EXISTS(SELECT 1 FROM technical_confirmation newer WHERE newer.series_id=t.series_id AND newer.version>t.version) superseded FROM technical_confirmation t LEFT JOIN technical_confirmation_signatures s ON s.tc_id=t.id WHERE t.id=$1`,
      [id],
    )
  ).rows[0];
  if (!t) throw new HttpError(404, "TC不存在");
  await tcProject(db, actor, t.project_id);
  return t;
}
export async function requireConfirmedTc(db: Db, actor: User, id: string) {
  const t = await tcRecord(db, actor, id);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "tc:" + t.series_id,
  ]);
  if (!t.file_id)
    throw new HttpError(
      409,
      "G-43/G-44：TC尚未记录客户签字，请在技术确认单上传并核实签字凭证",
    );
  if (
    (
      await db.query(
        "SELECT 1 FROM technical_confirmation WHERE series_id=$1 AND version>$2",
        [t.series_id, t.version],
      )
    ).rowCount
  )
    throw new HttpError(
      409,
      "源TC已升版，须确认新版本并处理变更，不能继续签发旧版",
    );
  return t;
}
export async function requireQuoteTc(db: Db, actor: User, quoteId: string) {
  const b = (
    await db.query(
      "SELECT tc_id FROM technical_quote_bindings WHERE quote_id=$1",
      [quoteId],
    )
  ).rows[0];
  if (!b)
    throw new HttpError(
      409,
      "G-43：报价未关联已签字TC；请进入“技术确认单 TC”关联此报价版本",
    );
  return requireConfirmedTc(db, actor, b.tc_id);
}
export async function requireCommercialAttachment(
  db: Db,
  actor: User,
  documentId: string,
) {
  const d = (
    await db.query(
      `SELECT x.*,r.doc_no,t.tc_no FROM technical_commercial_documents x JOIN crm_document_registry r ON r.id=x.registry_id JOIN technical_confirmation t ON t.id=x.tc_id WHERE x.document_id=$1`,
      [documentId],
    )
  ).rows[0];
  if (!d || d.attachment_no !== d.doc_no + "-A1")
    throw new HttpError(
      409,
      "G-43：该历史文件未附正确签字TC，保留归档但禁止正式外发；请创建关联TC的新报价版本",
    );
  await requireConfirmedTc(db, actor, d.tc_id);
  return d;
}
async function privacy(db: Db, tc: any, value: unknown) {
  await factorySafe(db, value);
  const body = JSON.stringify(value).toLowerCase();
  // Business fields have no place in a factory payload, even when pasted into free text.
  for (const [key, v] of Object.entries(
    tc.business as Record<string, string>,
  )) {
    if (
      !["projectName", "country", "port", "source"].includes(key) ||
      v.trim().length < 2
    )
      continue;
    const escaped = v
      .trim()
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      new RegExp(
        /^[a-z0-9 -]+$/i.test(v) ? `\\b${escaped}\\b` : escaped,
        "i",
      ).test(body)
    )
      throw new HttpError(
        422,
        "G-46：技术自由文本包含项目、国家或目的港等商务信息，请创建脱敏TC版本",
      );
  }
  if (
    /(?:\+\d[\d ()-]{7,}\d)|签字|signature|客户公司|联系人|收货地址/i.test(body)
  )
    throw new HttpError(422, "G-46：工厂内容包含联系方式或签字字段");
}
export async function safeManufacturing(db: Db, m: any) {
  if (!m.source_tc_id)
    throw new HttpError(
      409,
      "G-46：历史MO缺少可核验TC来源，禁止工厂下载；内部历史记录保留",
    );
  const t = (
    await db.query("SELECT * FROM technical_confirmation WHERE id=$1", [
      m.source_tc_id,
    ])
  ).rows[0];
  const technical = tcTechnicalSchema.parse(m.technical_snapshot.tcTechnical),
    production = productionSchema.parse(m.technical_snapshot.production);
  const diff = technicalDifferences(
    tcTechnicalSchema.parse(t.technical),
    technical,
  );
  if (diff.length)
    throw new HttpError(409, "G-44：已存MO技术差异：" + diff.join("；"));
  const view = {
    tcTechnical: technical,
    production,
    items: technical.items.map((i) => ({
      line: i.lineKey,
      widthMm: i.widthMm,
      heightMm: i.heightMm,
      quantity: i.quantity,
    })),
    requiredDate: production.requiredDate,
    sourceTcNo: t.tc_no,
    sourceTcVersion: t.version,
    partyA: z.object({name:z.string().max(160),confirmedAt:z.string()}).strict().parse(m.technical_snapshot.partyA),
  };
  await privacy(db, t, { technical, production });
  const changed = !!(
    await db.query(
      "SELECT 1 FROM technical_confirmation WHERE series_id=$1 AND version>$2",
      [t.series_id, t.version],
    )
  ).rowCount;
  return { technical: view, changeRequired: changed };
}
export function registerTechnical(app: Express, pool: pg.Pool, mutate: Mutate) {
  app.get("/api/supply/technical/:id/export/pdf", async (req, res) => {
    const t = await tcRecord(pool, req.actor, uid.parse(req.params.id)),
      p = await tcProject(pool, req.actor, t.project_id);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:14mm}body{font:12px/1.5 Arial,"Microsoft YaHei","Noto Sans CJK SC"}table{width:100%;border-collapse:collapse;table-layout:fixed}td,th{border:1px solid #aaa;padding:6px;overflow-wrap:anywhere}th{width:44%}tr{break-inside:avoid}h2{break-after:avoid}</style></head><body><h1>技术需求确认单 / Technical Confirmation</h1><p>${escape(t.tc_no)} V${t.version} · ${escape(p.crm_customer_code)} · ${escape(p.company)}</p><p>${t.superseded ? "历史版本 / Superseded" : t.file_id ? "客户签字已核实，签字凭证另存 / Signature evidence recorded" : "待客户签字确认 / Awaiting customer signature"}</p>${technicalHtml(t.technical,t.business.originalRequirements)}<h2>商务说明（仅客户与内部） / Commercial notes</h2><table>${Object.entries(
      t.business,
    )
      .filter(([k, v]) => k!=='originalRequirements' && v)
      .map(
        ([k, v]) =>
          `<tr><th>${escape(k)}</th><td>${escape(String(v))}</td></tr>`,
      )
      .join(
        "",
      )}</table><p>客户最终确认 / Customer signature: __________ 日期 / Date: __________</p></body></html>`;
    const bytes = await renderHtmlPdf(html);
    await repo.audit(pool, req.actor, "下载客户版TC", t.id, {
      version: t.version,
    });
    res
      .set("Cache-Control", "private, no-store")
      .set(
        "Content-Disposition",
        `attachment; filename="${t.tc_no}-V${t.version}.pdf"`,
      )
      .type("application/pdf")
      .send(await rasterPdf((await pool.query('SELECT pages FROM technical_drawings WHERE tc_id=$1 ORDER BY created_at,id',[t.id])).rows.flatMap(r=>r.pages),bytes));
  });
  app.get("/api/supply/technical", async (req, res) => {
    const projects = (
      await pool.query(
        `SELECT p.id,p.name,c.company,c.crm_customer_code FROM quotation_projects p JOIN customers c ON c.id=p.customer_id WHERE ($1::uuid IS NULL OR p.id=$1) AND c.deleted_at IS NULL AND NOT ${projectClosed} AND ${projectScope} ORDER BY p.created_at DESC LIMIT 1000`,
        [null, req.actor.role, req.actor.id],
      )
    ).rows;
    const records = (
      await pool.query(
        `SELECT t.id,t.project_id,t.tc_no,t.version,t.series_id,t.created_at,s.signed_on,EXISTS(SELECT 1 FROM technical_confirmation n WHERE n.series_id=t.series_id AND n.version>t.version) superseded FROM technical_confirmation t JOIN quotation_projects p ON p.id=t.project_id JOIN customers c ON c.id=p.customer_id LEFT JOIN technical_confirmation_signatures s ON s.tc_id=t.id WHERE ($1::uuid IS NULL OR p.id=$1) AND c.deleted_at IS NULL AND ${projectScope} ORDER BY t.created_at DESC`,
        [null,req.actor.role,req.actor.id],
      )
    ).rows;
    const reasons=(await pool.query(`SELECT count(*) FILTER(WHERE c.deleted_at IS NOT NULL)::int archived,count(*) FILTER(WHERE c.deleted_at IS NULL AND ${projectClosed})::int closed,count(*)::int visible FROM quotation_projects p JOIN customers c ON c.id=p.customer_id WHERE ($1::uuid IS NULL OR p.id=$1) AND ${projectScope}`,[null,req.actor.role,req.actor.id])).rows[0];
    const anyProject=(await pool.query('SELECT EXISTS(SELECT 1 FROM quotation_projects) present')).rows[0].present;
    res.json({ projects, records,availability:{...reasons,reason:projects.length?'ready':reasons.archived?'archived_customer':reasons.closed?'closed_project':anyProject&&req.actor.role!=='admin'?'no_permission':'no_projects',canCreate:['admin','sales'].includes(req.actor.role)} });
  });
  app.get("/api/supply/technical-project/:id", async (req, res) => {
    const p = await tcProject(pool, req.actor, uid.parse(req.params.id));
    const quotes = (
      await pool.query(
        "SELECT id,number,status,snapshot FROM quotation_versions WHERE project_id=$1 ORDER BY number DESC",
        [p.id],
      )
    ).rows;
    res.json({
      project: p.id,
      quotes: quotes.map((q) => ({
        id: q.id,
        number: q.number,
        status: q.status,
        lines: q.snapshot.lines.map((i: any) => ({
          lineKey: i.key,
          widthMm: i.widthMm,
          heightMm: i.heightMm,
          quantity: i.quantity,
          fields: {
            glass: i.specs?.glass ?? "",
            profile: i.specs?.profile ?? "",
            finish: i.specs?.finish ?? "",
            finalHardware: i.options.join("; "),
            special: i.special,
          },
        })),
      })),
    });
  });
  app.get("/api/supply/technical/:id", async (req, res) => {
    const t = await tcRecord(pool, req.actor, uid.parse(req.params.id));
    const files = (
      await pool.query(
        "SELECT id,name,kind FROM quotation_files WHERE project_id=$1 ORDER BY created_at DESC",
        [t.project_id],
      )
    ).rows;
    const quotes = (
      await pool.query(
        "SELECT q.id,q.number,q.status,b.tc_id FROM quotation_versions q LEFT JOIN technical_quote_bindings b ON b.quote_id=q.id WHERE q.project_id=$1 ORDER BY q.number DESC",
        [t.project_id],
      )
    ).rows;
    res.json({ ...t, files, quotes });
  });
  const saveSchema = z
    .object({
      projectId: uid,
      technical: tcTechnicalSchema,
      business: tcBusinessSchema,
      reason: z.string().trim().min(1).max(500),
      previousId: uid.optional(),
    })
    .strict();
  app.post("/api/supply/technical", async (req, res) =>
    mutate(req, res, async (db) => {
      const input = saveSchema.parse(req.body),
        p = await tcProject(db, req.actor, input.projectId);
      if(p.project_closed)throw new HttpError(409,'项目已关闭，请为后续业务新建报价项目；不恢复历史项目');
      if (!isCustomerCode(p.crm_customer_code))
        throw new HttpError(
          409,
          "客户缺少合规13位编号。历史编号保留，请先在客户主数据处理编号审核",
        );
      const previous = input.previousId
        ? await tcRecord(db, req.actor, input.previousId)
        : null;
      if (previous && previous.project_id !== p.id)
        throw new HttpError(409, "TC不能跨项目升版");
      const id = randomUUID(),
        series = previous?.series_id ?? id;
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "tc:" + series,
      ]);
      const latest = previous
        ? (
            await db.query(
              "SELECT max(version) n FROM technical_confirmation WHERE series_id=$1",
              [series],
            )
          ).rows[0].n
        : 0;
      if (previous && latest !== previous.version)
        throw new HttpError(409, "已有更新TC版本，请从最新版修改");
      const version = latest + 1;
      const insert = async (
        tx: pg.PoolClient,
        d: { id: string; doc_no: string },
      ) => {
        await tx.query(
          "INSERT INTO technical_confirmation(id,series_id,document_id,project_id,customer_id,tc_no,version,technical,business,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            id,
            series,
            d.id,
            p.id,
            p.customer_id,
            d.doc_no,
            version,
            JSON.stringify(input.technical),
            JSON.stringify(input.business),
            input.reason,
            req.actor.id,
          ],
        );
      };
      if (previous)
        await insert(db, { id: previous.document_id, doc_no: previous.tc_no });
      else
        await registerDocumentInTransaction(
          db,
          {
            classCode: "TC",
            customerIds: [p.customer_id],
            date: businessDay((await repo.settings(db)).timezone),
            businessKind: "technical_confirmation",
            businessId: id,
            requestKey: uid.parse(req.get("idempotency-key")),
            actorId: req.actor.id,
          },
          insert,
        );
      await repo.audit(db, req.actor, "TC版本保存", id, {
        version,
        previousId: previous?.id,
      });
      return { id, version };
    }),
  );
  app.post("/api/supply/technical/:id/confirm", async (req, res) =>
    mutate(req, res, async (db) => {
      const t = await tcRecord(db, req.actor, uid.parse(req.params.id));
      if (!["admin", "sales"].includes(req.actor.role))
        throw new HttpError(403, "客户签字须由管理员或负责销售核实");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "tc:" + t.series_id,
      ]);
      if ((await db.query('SELECT 1 FROM technical_confirmation WHERE series_id=$1 AND version>$2',[t.series_id,t.version])).rowCount) throw new HttpError(409, "请确认最新TC版本");
      const input = z
        .object({
          fileId: uid,
          signerName: z.string().trim().min(1).max(120),
          signedOn: z.iso.date(),
          verified: z.literal(true),
        })
        .strict()
        .parse(req.body);
      if (input.signedOn > businessDay((await repo.settings(db)).timezone))
        throw new HttpError(422, "签字日期不能晚于今天");
      if (
        !(
          await db.query(
            "SELECT 1 FROM quotation_files WHERE id=$1 AND project_id=$2 AND kind='confirmation'",
            [input.fileId, t.project_id],
          )
        ).rowCount
      )
        throw new HttpError(422, "必须使用本项目的客户确认附件");
      for (const i of tcTechnicalSchema.parse(t.technical).items)
        for (const k of [
          "productType",
          "profile",
          "material",
          "finish",
          "finalHardware",
          "packing",
          "protection",
          "special",
        ] as const)
          if (!i.fields[k])
            throw new HttpError(
              422,
              `${i.lineKey}缺少${k}，确不适用请写明不适用及原因`,
            );
      for (const i of tcTechnicalSchema.parse(t.technical).items)
        if (
          i.kind !== "door" &&
          (!i.fields.certifications || !i.fields.thirdPartyTests)
        )
          throw new HttpError(
            422,
            `${i.lineKey}缺少认证或第三方检测要求；不适用须注明原因`,
          );
      if (t.file_id) throw new HttpError(409, "已确认版本不可覆盖，请升版");
      await db.query(
        "INSERT INTO technical_confirmation_signatures(tc_id,file_id,signer_name,signed_on,verified_by) VALUES($1,$2,$3,$4,$5)",
        [t.id, input.fileId, input.signerName, input.signedOn, req.actor.id],
      );
      await repo.audit(db, req.actor, "核实TC客户签字", t.id, {
        fileId: input.fileId,
        signedOn: input.signedOn,
      });
      return { ok: true };
    }),
  );
  app.post("/api/supply/technical/:id/bind-quote", async (req, res) =>
    mutate(req, res, async (db) => {
      const t = await tcRecord(
          db,
          req.actor,
          uid.parse(req.params.id),
        ),
        input = z.object({ quoteId: uid }).strict().parse(req.body);
      const q = (
        await db.query(
          "SELECT * FROM quotation_versions WHERE id=$1 FOR UPDATE",
          [input.quoteId],
        )
      ).rows[0];
      if (!q || q.project_id !== t.project_id)
        throw new HttpError(409, "报价不属于TC项目");
      await requireConfirmedTc(db,req.actor,t.id);
      const lines = tcTechnicalSchema.parse(t.technical).items;
      for (const i of q.snapshot.lines) {
        const l = lines.find((t) => t.lineKey === i.key);
        if (
          !l ||
          l.quantity !== i.quantity ||
          l.widthMm !== i.widthMm ||
          l.heightMm !== i.heightMm
        )
          throw new HttpError(
            409,
            `报价行${i.key}的数量/尺寸与TC不符，请修订报价`,
          );
        const alias: Record<string, string> = {
          lock: "locks",
          hinge: "hinges",
          screen: "screens",
        };
        for (const [key, value] of Object.entries(i.specs ?? {}))
          if (
            value &&
            l.fields[(alias[key] ?? key) as keyof typeof l.fields] !== value
          )
            throw new HttpError(
              409,
              `报价行${i.key}的${key}与TC不符或尚未映射，请先修订技术要求`,
            );
        if (i.special && i.special !== l.fields.special)
          throw new HttpError(409, `报价行${i.key}的特殊要求与TC不符`);
        const tech = Object.values(l.fields).join("\n");
        if ((i.options ?? []).some((o: string) => !tech.includes(o)))
          throw new HttpError(
            409,
            `报价行${i.key}的配置选项未完整记录在TC技术字段`,
          );
      }
      if (lines.length !== q.snapshot.lines.length)
        throw new HttpError(409, "报价与TC产品明细必须一一对应");
      const existing = (
        await db.query(
          "SELECT tc_id FROM technical_quote_bindings WHERE quote_id=$1",
          [q.id],
        )
      ).rows[0];
      if (existing && existing.tc_id !== t.id)
        throw new HttpError(409, "已有源TC不可覆盖；请新建报价版本关联新TC");
      if (!existing)
        await db.query(
          "INSERT INTO technical_quote_bindings(quote_id,tc_id,bound_by) VALUES($1,$2,$3)",
          [q.id, t.id, req.actor.id],
        );
      await repo.audit(db, req.actor, "报价关联TC", q.id, { tcId: t.id });
      return { ok: true };
    }),
  );
  app.post("/api/supply/chain/:id/manufacturing-drafts", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const w = await workOrder(db, req.actor, uid.parse(req.params.id), true);
      const input = z
        .object({
          purchaseOrderId: uid,
          tcId: uid,
          lines: z
            .array(
              z.object({
                lineKey: z.string(),
                quantity: z.number().positive(),
              }),
            )
            .min(1),
          production: productionSchema,
        })
        .strict()
        .parse(req.body);
      const t = await requireConfirmedTc(db, req.actor, input.tcId),
        po = await purchaseOrder(db, req.actor, input.purchaseOrderId, true);
      if (
        t.project_id !== w.project_id ||
        po.work_order_id !== w.id ||
        po.status === "cancelled"
      )
        throw new HttpError(409, "TC、PO与WO必须属于同一项目及工单");
      const source = tcTechnicalSchema.parse(t.technical);
      if (input.lines.some(line=>!source.items.some(item=>item.lineKey===line.lineKey)))
        throw new HttpError(422,"分批明细不存在于源TC，请重新选择产品明细");
      const technical = selectBatch(source, input.lines);
      const id = randomUUID();
      await db.query(
        "INSERT INTO crm_manufacturing_drafts(id,work_order_id,purchase_order_id,source_tc_id,technical,production,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          w.id,
          po.id,
          t.id,
          JSON.stringify(technical),
          JSON.stringify(input.production),
          req.actor.id,
        ],
      );
      return { id };
    }),
  );
  app.get("/api/supply/manufacturing-drafts/:id", async (req, res) => {
    const d = (
      await pool.query("SELECT * FROM crm_manufacturing_drafts WHERE id=$1", [
        uid.parse(req.params.id),
      ])
    ).rows[0];
    if (!d) throw new HttpError(404, "草稿不存在");
    await workOrder(pool, req.actor, d.work_order_id);
    const t = await tcRecord(pool, req.actor, d.source_tc_id);
    res.json({
      ...d,
      sourceTcNo: t.tc_no,
      sourceTcVersion: t.version,
      superseded: t.superseded,
      differences: technicalDifferences(t.technical, d.technical),
      issued:
        (
          await pool.query(
            "SELECT id FROM crm_manufacturing_orders WHERE draft_id=$1",
            [d.id],
          )
        ).rows[0]?.id ?? null,
    });
  });
  app.put("/api/supply/manufacturing-drafts/:id", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const input = z
        .object({
          revision: z.number().int(),
          technical: tcTechnicalSchema,
          production: productionSchema,
        })
        .strict()
        .parse(req.body);
      const d = (
        await db.query(
          "SELECT * FROM crm_manufacturing_drafts WHERE id=$1 FOR UPDATE",
          [uid.parse(req.params.id)],
        )
      ).rows[0];
      if (!d) throw new HttpError(404, "草稿不存在");
      await workOrder(db, req.actor, d.work_order_id);
      if (
        (
          await db.query(
            "SELECT 1 FROM crm_manufacturing_orders WHERE draft_id=$1",
            [d.id],
          )
        ).rowCount
      )
        throw new HttpError(409, "已下达MO不可修改");
      const saved = await db.query(
        "UPDATE crm_manufacturing_drafts SET technical=$2,production=$3,revision=revision+1 WHERE id=$1 AND revision=$4 RETURNING revision",
        [
          d.id,
          JSON.stringify(input.technical),
          JSON.stringify(input.production),
          input.revision,
        ],
      );
      if (!saved.rowCount) throw new HttpError(409, "草稿已变化，请刷新");
      return saved.rows[0];
    }),
  );
  app.post("/api/supply/manufacturing-drafts/:id/issue", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const input = z
        .object({
          revision: z.number().int(),
          partyAConfirmed: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const d = (
        await db.query(
          "SELECT * FROM crm_manufacturing_drafts WHERE id=$1 FOR UPDATE",
          [uid.parse(req.params.id)],
        )
      ).rows[0];
      if (!d) throw new HttpError(404, "草稿不存在");
      const prior = (
        await db.query(
          "SELECT m.id,r.doc_no FROM crm_manufacturing_orders m JOIN crm_document_registry r ON r.id=m.document_id WHERE draft_id=$1",
          [d.id],
        )
      ).rows[0];
      if (prior) return prior;
      if (d.revision !== input.revision)
        throw new HttpError(409, "请刷新最新草稿再下达");
      const w = await workOrder(db, req.actor, d.work_order_id, true),
        t = await requireConfirmedTc(db, req.actor, d.source_tc_id),
        po = await purchaseOrder(db, req.actor, d.purchase_order_id, true);
      if (po.status === "cancelled" || t.project_id !== w.project_id)
        throw new HttpError(409, "采购单已取消或TC项目不匹配");
      const binding = (
        await db.query(
          "SELECT tc_id FROM technical_quote_bindings WHERE quote_id=$1",
          [po.quote_id],
        )
      ).rows[0];
      if (binding?.tc_id !== t.id)
        throw new HttpError(
          409,
          "G-44：订单报价所引用TC版本与MO不一致；请先完成订单变更",
        );
      const workflow = await orderWorkflow(db, w.sales_order_id);
      requireProductionInstruction(workflow.evidence);
      const technical = tcTechnicalSchema.parse(d.technical),
        production = productionSchema.parse(d.production),
        diff = technicalDifferences(t.technical, technical);
      if (diff.length) throw new HttpError(409, "G-44：" + diff.join("；"));
      const quantities = (
        await db.query(
          "SELECT pi.quantity,si.line_key FROM purchase_order_items pi JOIN sales_order_items si ON si.id=pi.sales_order_item_id WHERE purchase_order_id=$1",
          [po.id],
        )
      ).rows;
      const previous = (
        await db.query(
          "SELECT m.technical_snapshot,m.purchase_order_id FROM crm_manufacturing_orders m JOIN technical_confirmation t ON t.id=m.source_tc_id WHERE t.series_id=$1",
          [t.series_id],
        )
      ).rows;
      const dimensions =
        workflow.records.findLast((r) => r.kind === "dimensions")?.data.lines ??
        [];
      const soItems = (
        await db.query(
          "SELECT id,line_key FROM sales_order_items WHERE sales_order_id=$1",
          [w.sales_order_id],
        )
      ).rows;
      for (const l of technical.items) {
        const p = quantities.find((q) => q.line_key === l.lineKey),
          source = t.technical.items.find((i: any) => i.lineKey === l.lineKey);
        const used = (samePo: boolean) =>
          previous
            .filter((r) => !samePo || r.purchase_order_id === po.id)
            .flatMap((r) => r.technical_snapshot.tcTechnical?.items ?? [])
            .filter((i: any) => i.lineKey === l.lineKey)
            .reduce((n: Decimal, i: any) => n.plus(i.quantity), new Decimal(0));
        if (
          !p ||
          used(true).plus(l.quantity).gt(p.quantity) ||
          used(false).plus(l.quantity).gt(source.quantity)
        )
          throw new HttpError(
            409,
            `分批累计数量超限：${l.lineKey}（TC及PO双重校验）`,
          );
        const measured = dimensions.find(
          (x: any) =>
            x.itemId === soItems.find((i) => i.line_key === l.lineKey)?.id,
        );
        if (
          !measured ||
          Number(measured.widthMm) !== l.widthMm ||
          Number(measured.heightMm) !== l.heightMm
        )
          throw new HttpError(
            409,
            `G-44：${l.lineKey}与最终量尺尺寸不一致，请修订TC并重新确认`,
          );
      }
      await privacy(db, t, { technical, production });
      await latestTcDrawings(db,t.id,technical.items.map(i=>i.lineKey));
      const id = randomUUID(),
        partyA = {
          name: req.actor.name,
          confirmedAt: new Date().toISOString(),
        };
      const document = await registerDocumentInTransaction(
        db,
        {
          classCode: "MO",
          customerIds: [w.customer_id],
          date: businessDay((await repo.settings(db)).timezone),
          businessKind: "manufacturing_order",
          businessId: d.id,
          requestKey: uid.parse(req.get("idempotency-key")),
          actorId: req.actor.id,
        },
        async (tx, r) => {
          await tx.query(
            `INSERT INTO crm_manufacturing_orders(id,document_id,work_order_id,purchase_order_id,customer_id,customer_code,technical_snapshot,created_by,source_tc_id,source_tc_no,source_tc_version,consistency_checked_on,consistency_result,draft_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,$13)`,
            [
              id,
              r.id,
              w.id,
              po.id,
              w.customer_id,
              w.customer_code,
              JSON.stringify({
                tcTechnical: technical,
                production,
                partyA,
                templateVersion: "TC-MO-20261015",
              }),
              req.actor.id,
              t.id,
              t.tc_no,
              t.version,
              JSON.stringify({
                result: "matched",
                mapping: "TC-MO-20261015",
                differences: [],
              }),
              d.id,
            ],
          );
        },
      );
      await linkTcDrawings(db,id,t.id,technical.items.map(i=>i.lineKey),req.actor.id);
      await repo.audit(db, req.actor, "甲方签认并下达TC生产指令", id, {
        tcId: t.id,
        version: t.version,
        docNo: document.doc_no,
      });
      return { id, docNo: document.doc_no };
    }),
  );
}
