import type { Express, Request, Response } from "express";
import type pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db.ts";
import { businessDay, HttpError, requireAdmin } from "../domain.ts";
import { audit } from "../repository.ts";
import {
  logisticsPolicySchema,
  rateSchema,
  type CostRate,
  type LogisticsSnapshot,
} from "../../shared/logistics.ts";
import { readImport } from "../pricing/imports.ts";
import { productSchema } from "../../shared/quoting.ts";
import ExcelJS from "exceljs";
type Mutate = (
  req: Request,
  res: Response,
  run: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;
const maintain = (role: string) => {
  if (!["admin", "coordinator", "logistics"].includes(role))
    throw new HttpError(403, "仅管理员、跟单员或物流可维护物流费率");
};
const costs = (role: string) => {
  if (!["admin", "coordinator"].includes(role))
    throw new HttpError(403, "采购成本仅限管理员及跟单员");
};
const normalize = (r: any): CostRate => ({
  ...r.data,
  id: r.id,
  series_id: r.series_id,
  version: r.version,
  is_current: r.is_current,
});
export async function loadCostRates(
  db: Db,
  ids: string[],
): Promise<CostRate[]> {
  return (
    await db.query(
      "SELECT * FROM logistics_cost_rates WHERE id=ANY($1::uuid[]) ORDER BY series_id",
      [ids],
    )
  ).rows.map(normalize);
}
export async function logisticsChanges(db: Db, s?: LogisticsSnapshot) {
  if (!s) return ["G-36：旧草稿缺少物流规则快照，请另存新版本"];
  const rows = await loadCostRates(
    db,
    s.rates.map((r) => r.id),
  );
  return s.rates
    .filter(
      (r) =>
        !rows.some(
          (v) => v.id === r.id && v.version === r.version && v.is_current,
        ),
    )
    .map((r) => `G-36：${r.name}已升版；原报价不变，请重新核算`);
}
async function saveRate(
  db: Db,
  actor: { id: string; role: string },
  raw: unknown,
  reason: string,
  previousId?: string,
) {
  maintain(actor.role);
  const data = rateSchema.parse(raw),
    today = businessDay("Asia/Shanghai");
  if (data.sourceDate > today)
    throw new HttpError(422, "来源发布日期不能在未来");
  if (data.evidence.startsWith("file:")) {
    if (
      !(
        await db.query("SELECT 1 FROM logistics_evidence WHERE id::text=$1", [
          data.evidence.slice(5),
        ])
      ).rowCount
    )
      throw new HttpError(422, "报价凭证不存在");
  } else {
    const u = z.url().parse(data.evidence);
    if (!u.startsWith("https://"))
      throw new HttpError(422, "请输入原始报价HTTPS凭据链接或上传凭证");
  }
  if (data.tariffId) {
    const t = (
      await db.query("SELECT * FROM tariff_records WHERE id=$1 FOR SHARE", [
        data.tariffId,
      ])
    ).rows[0];
    if (
      !t ||
      !t.is_current ||
      t.verification !== "verified" ||
      t.reference_only ||
      t.tax_kind !== data.kind
    )
      throw new HttpError(422, "须关联当前已官方核验的同税种T40记录");
    const match = String(t.rate_text).match(/^\s*(\d+(?:\.\d+)?)\s*%\s*$/);
    if (!match || Number(match[1]) !== data.rate)
      throw new HttpError(
        422,
        "计算税率与已核验税率不一致，复合税不能当作百分比",
      );
  }
  let version = 1,
    series = randomUUID();
  if (previousId) {
    const old = (
      await db.query(
        "SELECT * FROM logistics_cost_rates WHERE id=$1 FOR UPDATE",
        [previousId],
      )
    ).rows[0];
    if (!old || !old.is_current) throw new HttpError(409, "费率已升版，请刷新");
    series = old.series_id;
    version = old.version + 1;
    await db.query(
      "UPDATE logistics_cost_rates SET is_current=false WHERE id=$1",
      [previousId],
    );
  }
  const id = randomUUID();
  await db.query(
    "INSERT INTO logistics_cost_rates(id,series_id,version,data,created_by,reason) VALUES($1,$2,$3,$4,$5,$6)",
    [id, series, version, JSON.stringify(data), actor.id, reason],
  );
  await audit(db, actor as never, "登记物流费率版本", id, {
    previousId: previousId ?? null,
    version,
    reason,
  });
  return { id, version };
}
const headers = [
  "名称",
  "费用类型",
  "国家",
  "起运港",
  "目的地",
  "运输方式",
  "币种",
  "单位",
  "费率",
  "最低收费",
  "生效日期",
  "失效日期",
  "来源日期",
  "提供方",
  "凭证链接",
  "适用说明",
];
export function registerLogistics(app: Express, pool: pg.Pool, mutate: Mutate) {
  app.use("/api/logistics", (req, _res, next) => {
    if (
      !["admin", "coordinator", "logistics", "sales"].includes(req.actor.role)
    )
      throw new HttpError(403, "无物流计价权限");
    next();
  });
  app.get("/api/logistics/rates", async (req, res) => {
    const data = (
        await pool.query(
          "SELECT * FROM logistics_cost_rates WHERE is_current ORDER BY created_at DESC LIMIT 3000",
        )
      ).rows.map(normalize),
      canCost = req.actor.role !== "sales",
      today = businessDay("Asia/Shanghai");
    res.json(
      data.map((r) => ({
        ...(canCost
          ? r
          : {
              id: r.id,
              series_id: r.series_id,
              version: r.version,
              is_current: r.is_current,
              name: r.name,
              kind: r.kind,
              country: r.country,
              originPort: r.originPort,
              destination: r.destination,
              transport: r.transport,
              currency: r.currency,
              unit: r.unit,
              provider: r.provider,
              sourceDate: r.sourceDate,
              validFrom: r.validFrom,
              validUntil: r.validUntil,
              scope: r.scope,
            }),
        status:
          r.validUntil < today
            ? "已过期"
            : r.validFrom > today
              ? "未生效"
              : "有效",
      })),
    );
  });
  app.get("/api/logistics/policy", async (req, res) => {
    costs(req.actor.role);
    const r = (
      await pool.query("SELECT data,version FROM quotation_settings WHERE id=1")
    ).rows[0];
    res.json({
      data: logisticsPolicySchema.parse(r.data.logisticsPolicy ?? {}),
      version: r.version,
    });
  });
  app.put("/api/logistics/policy", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const i = z
        .object({
          data: logisticsPolicySchema,
          version: z.number().int(),
          reason: z.string().trim().min(5).max(1000),
        })
        .parse(req.body);
      const old = (
        await db.query(
          "SELECT data,version FROM quotation_settings WHERE id=1 FOR UPDATE",
        )
      ).rows[0];
      if (old.version !== i.version)
        throw new HttpError(409, "规则已变更，请刷新");
      await db.query(
        "UPDATE quotation_settings SET data=jsonb_set(data,'{logisticsPolicy}',$1),version=version+1 WHERE id=1",
        [JSON.stringify(i.data)],
      );
      await audit(
        db,
        req.actor,
        "修改物流与产品底线系数",
        "quotation_settings",
        {
          old: logisticsPolicySchema.parse(old.data.logisticsPolicy ?? {}),
          new: i.data,
          reason: i.reason,
        },
      );
      return { version: i.version + 1 };
    }),
  );
  app.post("/api/logistics/rates", async (req, res) =>
    mutate(req, res, (db) =>
      saveRate(
        db,
        req.actor,
        req.body.data,
        z.string().trim().min(5).max(1000).parse(req.body.reason),
      ),
    ),
  );
  app.post("/api/logistics/rates/:id/version", async (req, res) =>
    mutate(req, res, (db) =>
      saveRate(
        db,
        req.actor,
        req.body.data,
        z.string().trim().min(5).max(1000).parse(req.body.reason),
        z.uuid().parse(req.params.id),
      ),
    ),
  );
  app.get("/api/logistics/rates/:id/history", async (req, res) => {
    maintain(req.actor.role);
    res.json(
      (
        await pool.query(
          "SELECT * FROM logistics_cost_rates WHERE series_id=(SELECT series_id FROM logistics_cost_rates WHERE id=$1) ORDER BY version DESC",
          [z.uuid().parse(req.params.id)],
        )
      ).rows,
    );
  });
  app.post("/api/logistics/evidence", async (req, res) =>
    mutate(req, res, async (db) => {
      maintain(req.actor.role);
      const i = z
          .object({ name: z.string().max(180), data: z.string().max(2800000) })
          .parse(req.body),
        bytes = Buffer.from(i.data, "base64");
      const mime =
        bytes.subarray(0, 5).toString() === "%PDF-"
          ? "application/pdf"
          : bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ? "image/png"
            : bytes[0] === 255 && bytes[1] === 216
              ? "image/jpeg"
              : null;
      if (!mime || bytes.length > 2 * 1024 * 1024)
        throw new HttpError(422, "只接受2MB以内PDF/PNG/JPEG凭证");
      const id = randomUUID();
      await db.query(
        "INSERT INTO logistics_evidence(id,name,mime,bytes,sha256,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          i.name,
          mime,
          bytes,
          createHash("sha256").update(bytes).digest("hex"),
          req.actor.id,
        ],
      );
      return { evidence: `file:${id}` };
    }),
  );
  app.get("/api/logistics/evidence/:id", async (req, res) => {
    maintain(req.actor.role);
    const r = (
      await pool.query(
        "SELECT name,mime,bytes FROM logistics_evidence WHERE id=$1",
        [z.uuid().parse(req.params.id)],
      )
    ).rows[0];
    if (!r) throw new HttpError(404, "凭证不存在");
    res.type(r.mime).attachment(r.name).send(r.bytes);
  });
  app.get("/api/logistics/import-template", (req, res) => {
    maintain(req.actor.role);
    res
      .type("text/csv; charset=utf-8")
      .attachment("logistics-rates.csv")
      .send("\uFEFF" + headers.join(",") + "\r\n");
  });
  app.post("/api/logistics/import-preview", async (req, res) => {
    maintain(req.actor.role);
    const i = z
        .object({ name: z.string().max(180), data: z.string().max(2800000) })
        .parse(req.body),
      bytes = Buffer.from(i.data, "base64"),
      rows = await readImport(bytes, i.name);
    const mapped = rows.map((r, index) => {
      const parsed = rateSchema.safeParse({
        name: r["名称"],
        kind: r["费用类型"],
        country: r["国家"],
        originPort: r["起运港"] || "",
        destination: r["目的地"] || "",
        transport: r["运输方式"] || "any",
        currency: r["币种"],
        unit: r["单位"],
        rate:
          r["费率"] === "" || r["费率"] == null ? undefined : Number(r["费率"]),
        minimum:
          r["最低收费"] === "" || r["最低收费"] == null
            ? 0
            : Number(r["最低收费"]),
        validFrom: r["生效日期"],
        validUntil: r["失效日期"],
        sourceDate: r["来源日期"],
        provider: r["提供方"],
        evidence: r["凭证链接"],
        scope: r["适用说明"],
      });
      return {
        row: index + 2,
        data: parsed.success ? parsed.data : null,
        errors: parsed.success
          ? []
          : parsed.error.issues.map((e) => `${e.path.join(".")}:${e.message}`),
      };
    });
    await mutate(req, res, async (db) => {
      const known = new Set<string>();
      for (const row of mapped) {
        if (!row.data) continue;
        const key = JSON.stringify(row.data);
        const duplicate = known.has(key) || !!(await db.query(
          "SELECT 1 FROM logistics_cost_rates WHERE data=$1 AND is_current LIMIT 1", [key],
        )).rowCount;
        Object.assign(row, { duplicate });
        known.add(key);
      }
      const id = randomUUID();
      await db.query(
        "INSERT INTO logistics_imports(id,name,bytes,rows,created_by) VALUES($1,$2,$3,$4,$5)",
        [id, i.name, bytes, JSON.stringify(mapped), req.actor.id],
      );
      return { id, rows: mapped };
    });
  });
  app.post("/api/logistics/imports/:id/commit", async (req, res) =>
    mutate(req, res, async (db) => {
      maintain(req.actor.role);
      const r = (
        await db.query(
          "SELECT * FROM logistics_imports WHERE id=$1 AND (created_by=$2 OR $3='admin') FOR UPDATE",
          [z.uuid().parse(req.params.id), req.actor.id, req.actor.role],
        )
      ).rows[0];
      if (!r) throw new HttpError(404, "预览不存在");
      if (r.committed_at) return { alreadyCommitted: true };
      if (!r.rows.length || r.rows.some((v: any) => v.errors.length))
        throw new HttpError(422, "存在错误行，不能部分或空白导入");
      // Different upload batches must not race their duplicate check and insertion.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('logistics-import-dedup'))");
      const result = [];
      for (const row of r.rows) {
        const same = (
          await db.query(
            "SELECT id FROM logistics_cost_rates WHERE data=$1 AND is_current",
            [JSON.stringify(row.data)],
          )
        ).rows[0];
        result.push(
          same ??
            (await saveRate(
              db,
              req.actor,
              row.data,
              `人工确认导入 ${r.id} 第${row.row}行`,
            )),
        );
      }
      await db.query(
        "UPDATE logistics_imports SET committed_at=now() WHERE id=$1",
        [r.id],
      );
      return { count: result.length };
    }),
  );
  app.get("/api/logistics/products", async (req, res) => {
    costs(req.actor.role);
    res.json(
      (
        await pool.query(
          "SELECT id,version,data FROM quotation_products ORDER BY sku LIMIT 2000",
        )
      ).rows,
    );
  });
  app.post("/api/logistics/products/:id/cost", async (req, res) =>
    mutate(req, res, async (db) => {
      costs(req.actor.role);
      const i = z
        .object({
          version: z.number().int(),
          cost: z.number().min(0).max(1e9),
          guide: z.number().min(0).max(1e9),
          sourceDate: z.iso.date(),
          validFrom: z.iso.date(),
          validUntil: z.iso.date(),
          provider: z.string().trim().min(1).max(200),
          evidence: z.url().startsWith("https://"),
          reason: z.string().trim().min(5).max(1000),
          options: z
            .array(
              z.object({
                id: z.string(),
                cost: z.number().min(0).max(1e9),
                sale: z.number().min(0).max(1e9),
              }),
            )
            .optional(),
        })
        .parse(req.body);
      if (
        i.validFrom > businessDay("Asia/Shanghai") ||
        i.validFrom > i.validUntil ||
        i.sourceDate > businessDay("Asia/Shanghai")
      )
        throw new HttpError(
          422,
          "本入口仅发布已生效成本，来源日期不能在未来；未来价格请在生效日升版",
        );
      const r = (
        await db.query(
          "SELECT * FROM quotation_products WHERE id=$1 FOR UPDATE",
          [z.uuid().parse(req.params.id)],
        )
      ).rows[0];
      if (!r || r.version !== i.version)
        throw new HttpError(409, "产品已变更，请刷新");
      const settings = (
          await db.query("SELECT data FROM quotation_settings WHERE id=1")
        ).rows[0],
        policy = logisticsPolicySchema.parse(
          settings.data.logisticsPolicy ?? {},
        );
      if (
        i.options &&
        (new Set(i.options.map((o) => o.id)).size !== i.options.length ||
          i.options.length !== r.data.options.length ||
          i.options.some(
            (o) => !r.data.options.some((p: any) => p.id === o.id),
          ))
      )
        throw new HttpError(
          422,
          "配置选项已变化，请刷新；本入口不能删除或复制配置",
        );
      const data = productSchema.parse({
        ...r.data,
        options: r.data.options.map((o: any) => ({
          ...o,
          ...i.options?.find((v) => v.id === o.id),
        })),
        prices: {
          ...r.data.prices,
          internal: i.cost,
          factory: i.cost,
          guide: i.guide,
          minimum: Math.round(i.cost * policy.floorMultiplier * 100) / 100,
        },
        priceValidUntil: i.validUntil,
        provenance: {
          provider: i.provider,
          sourceDate: i.sourceDate,
          validFrom: i.validFrom,
          importedAt: new Date().toISOString(),
          approvedAt: new Date().toISOString(),
          importId: null,
          method: "manual",
          evidence: i.evidence,
          note: i.reason,
        },
      });
      await db.query(
        "UPDATE quotation_products SET data=$2,version=version+1,updated_at=now() WHERE id=$1",
        [r.id, JSON.stringify(data)],
      );
      await audit(db, req.actor, "产品P-COST与销售基价升版", r.id, {
        oldVersion: r.version,
        newVersion: r.version + 1,
        evidence: i.evidence,
        reason: i.reason,
      });
      return { version: r.version + 1 };
    }),
  );
  app.get(
    ["/api/logistics/sheets/:id", "/api/logistics/sheets/:id/export"],
    async (req, res) => {
      costs(req.actor.role);
      const r = (
        await pool.query(
          "SELECT l.*,v.number,v.project_id,c.crm_customer_code,d.doc_no FROM logistics_quote_sheets l JOIN quotation_versions v ON v.id=l.quote_id JOIN quotation_projects p ON p.id=v.project_id JOIN customers c ON c.id=p.customer_id LEFT JOIN crm_document_registry d ON d.id=v.registered_document_id WHERE l.quote_id=$1 AND c.deleted_at IS NULL",
          [z.uuid().parse(req.params.id)],
        )
      ).rows[0];
      if (!r) throw new HttpError(404, "此历史报价没有物流快照，不能补造");
      if (
        req.actor.role === "coordinator" &&
        !(
          await pool.query(
            "SELECT 1 FROM crm_work_orders w JOIN sales_orders so ON so.id=w.sales_order_id JOIN quotation_orders qo ON qo.id=so.quotation_order_id WHERE qo.quote_id=$1 AND w.scm_owner=$2",
            [r.quote_id, req.actor.id],
          )
        ).rowCount
      )
        throw new HttpError(403, "仅可查看本人跟单工单的物流计价单");
      if (req.path.endsWith("/export")) {
        const b = new ExcelJS.Workbook(),
          sheet = b.addWorksheet("内部物流计价 Internal"),
          s = r.snapshot as LogisticsSnapshot;
        sheet.addRows([
          ["内部文件，不得外发 / Internal only"],
          ["客户编号 Customer Code", r.crm_customer_code],
          ["报价编号 QT", r.doc_no ?? "草稿未签发"],
          ["版本 Quote version", r.number],
          ["术语 Incoterm", s.term],
          ["范围 Scope", s.scope],
          ["规则版本", s.ruleVersion],
          ["成本 CNY", s.costCny],
          ["销售 CNY", s.saleCny],
          ["底线 CNY", s.floorCny],
          ["风险缓冲 CNY", s.riskCny],
          ["利润 CNY", s.profitCny],
          [],
          ["费用", "成本 CNY", "计算依据"],
          ...s.components.map((v) => [v.kind, v.costCny, v.basis]),
        ]);
        sheet.columns = [{ width: 32 }, { width: 28 }, { width: 90 }];
        await audit(pool, req.actor, "导出内部物流计价快照", r.quote_id);
        res
          .type(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          )
          .attachment("logistics-internal.xlsx")
          .send(Buffer.from(await b.xlsx.writeBuffer()));
        return;
      }
      res.json(r);
    },
  );
}
