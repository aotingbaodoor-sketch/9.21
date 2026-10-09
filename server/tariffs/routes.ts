import type { Express, Request, Response } from "express";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  tariffRecordInput,
  tariffSchedule,
  tariffWarning,
  type TariffDbRecord as TariffRecord,
} from "../../shared/tariffs.ts";
import { requireAdmin, HttpError, businessDay } from "../domain.ts";
import { audit } from "../repository.ts";
import { nextRun } from "../pricing/sync.ts";
import { saveRate } from "./sync.ts";
import { automatedSources } from "./sources.ts";
type Mutate = (
  req: Request,
  res: Response,
  run: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;
export function registerTariffs(app: Express, pool: pg.Pool, mutate: Mutate) {
  app.use("/api/tariffs", (req, _res, next) => {
    if (!["admin", "sales", "logistics"].includes(req.actor.role))
      throw new HttpError(403, "无税率查询权限");
    next();
  });
  app.get("/api/tariffs/alerts/count", async (req, res) => {
    requireAdmin(req.actor);
    res.json(
      (
        await pool.query(
          "SELECT count(*)::int count FROM automation_rule WHERE code='tariff_sync' AND last_error IS NOT NULL",
        )
      ).rows[0],
    );
  });
  app.get("/api/tariffs", async (req, res) => {
    const q = String(req.query.q || "").slice(0, 100),
      country = String(req.query.country || "").toUpperCase(),
      origin = String(req.query.origin || "").toUpperCase(),
      review = String(req.query.review || "");
    const page = Math.max(1, Math.min(10000, Number(req.query.page) || 1));
    const where = `r.is_current AND ($1='' OR r.country=$1) AND ($2='' OR r.origin=$2) AND ($3='' OR r.verification=$3) AND (r.hs_code LIKE $4 OR r.description ILIKE $4 OR s.name ILIKE $4)`;
    const params = [
      country,
      origin,
      review,
      "%" + q.replace(/[\\%_]/g, "\\$&") + "%",
    ];
    const sources = (
      await pool.query(
        "SELECT * FROM tariff_source_registry ORDER BY region,code",
      )
    ).rows;
    const records = (
      await pool.query(
        `SELECT r.*,s.name source_name,s.status source_status,s.last_error source_error,u.name reviewer_name FROM tariff_records r JOIN tariff_source_registry s ON s.code=r.source_code LEFT JOIN users u ON u.id=r.verified_by WHERE ${where} ORDER BY r.country,r.hs_code,r.data_year DESC NULLS LAST,r.fetched_at DESC LIMIT 100 OFFSET $5`,
        [...params, (page - 1) * 100],
      )
    ).rows as TariffRecord[];
    const total = Number(
      (
        await pool.query(
          `SELECT count(*) FROM tariff_records r JOIN tariff_source_registry s ON s.code=r.source_code WHERE ${where}`,
          params,
        )
      ).rows[0].count,
    );
    const rule = (
      await pool.query(
        "SELECT enabled,config,version,next_run,last_heartbeat,last_success,last_error FROM automation_rule WHERE code='tariff_sync'",
      )
    ).rows[0];
    const runs = (
      await pool.query(
        "SELECT * FROM tariff_sync_runs ORDER BY started_at DESC LIMIT 20",
      )
    ).rows;
    res.json({
      sources,
      records: records.map(({ raw_data: _raw, ...r }) => ({
        ...r,
        warning: tariffWarning(r, businessDay("Asia/Shanghai")),
      })),
      total,
      page,
      rule,
      runs,
    });
  });
  app.put("/api/tariffs/sources/:code", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const i = z
        .object({
          version: z.number().int(),
          enabled: z.boolean(),
          notes: z.string().max(4000),
          requirements: z.string().max(2000),
        })
        .parse(req.body);
      if (i.enabled && !automatedSources.includes(String(req.params.code)))
        throw new HttpError(
          422,
          "此来源尚无已验证适配器，不能开启自动更新；请人工录入复核",
        );
      const r = await db.query(
        "UPDATE tariff_source_registry SET enabled=$1,notes=$2,requirements=$3,version=version+1,updated_by=$4,updated_at=now() WHERE code=$5 AND version=$6 RETURNING code,version",
        [
          i.enabled,
          i.notes,
          i.requirements,
          req.actor.id,
          req.params.code,
          i.version,
        ],
      );
      if (!r.rowCount) throw new HttpError(409, "来源已变更，请刷新");
      await audit(db, req.actor, "更新税率数据源", String(req.params.code));
      return r.rows[0];
    }),
  );
  app.put("/api/tariffs/config", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const i = z
        .object({
          version: z.number().int(),
          enabled: z.boolean(),
          config: tariffSchedule,
        })
        .parse(req.body);
      const r = await db.query(
        "UPDATE automation_rule SET enabled=$1,config=$2,version=version+1,next_run=$3,updated_by=$4,updated_at=now() WHERE code='tariff_sync' AND version=$5 RETURNING version",
        [
          i.enabled,
          JSON.stringify(i.config),
          nextRun([i.config.time]),
          req.actor.id,
          i.version,
        ],
      );
      if (!r.rowCount) throw new HttpError(409, "更新计划已变化，请刷新");
      await audit(db, req.actor, "配置税率云端任务", "tariff_sync");
      return r.rows[0];
    }),
  );
  app.post("/api/tariffs/run", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      await db.query(
        "UPDATE automation_rule SET next_run=now(),requested_by=$1 WHERE code='tariff_sync'",
        [req.actor.id],
      );
      await audit(db, req.actor, "请求税率同步", "tariff_sync");
      return { message: "服务器将在一分钟内检查，不依赖浏览器开启" };
    }),
  );
  app.post("/api/tariffs/records", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const i = tariffRecordInput.parse(req.body);
      if (["wits", "owid", "uk_bulk", "wco"].includes(i.sourceCode))
        throw new HttpError(
          422,
          "此来源只提供统计/归类参考，不能登记为正式产品税率；请选择目的国官方税则来源",
        );
      if (
        !(
          await db.query("SELECT 1 FROM tariff_source_registry WHERE code=$1", [
            i.sourceCode,
          ])
        ).rowCount
      )
        throw new HttpError(422, "来源未登记");
      let series = "manual:" + randomUUID();
      if (i.supersedesId) {
        const old = (
          await db.query(
            "SELECT * FROM tariff_records WHERE id=$1 FOR UPDATE",
            [i.supersedesId],
          )
        ).rows[0];
        if (
          !old ||
          !old.is_current ||
          old.reference_only ||
          old.source_code !== i.sourceCode
        )
          throw new HttpError(409, "只能修订同一来源当前人工记录");
        series = old.series_key;
      }
      const r = await saveRate(
        db,
        i.sourceCode,
        {
          series_key: series,
          country: i.country,
          origin: i.origin,
          hs_code: i.hsCode,
          description: i.description,
          tax_kind: i.taxKind,
          rate_text: i.rateText,
          conditions: i.conditions,
          effective_from: i.effectiveFrom,
          effective_until: i.effectiveUntil,
          data_year: i.dataYear,
          source_url: i.sourceUrl,
          source_published_at: null,
          reference_only: false,
          raw_data: { method: "manual" },
        },
        req.actor.id,
      );
      await audit(db, req.actor, "录入税率待复核版本", r.id);
      return r;
    }),
  );
  app.post("/api/tariffs/records/:id/review", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const i = z
        .object({
          version: z.number().int(),
          approved: z.boolean(),
          note: z.string().trim().min(10).max(3000),
          evidenceUrl: z.url().refine((v) => /^https?:\/\//.test(v)),
          confirmedNationalCode: z.literal(true),
          confirmedOrigin: z.literal(true),
          confirmedAdditionalMeasures: z.literal(true),
        })
        .parse(req.body);
      const r = (
        await db.query("SELECT * FROM tariff_records WHERE id=$1 FOR UPDATE", [
          z.uuid().parse(req.params.id),
        ])
      ).rows[0] as TariffRecord;
      if (!r || !r.is_current || r.version !== i.version)
        throw new HttpError(409, "税率版本已变化，请刷新");
      if (r.reference_only)
        throw new HttpError(
          422,
          "参考/平均数据不能直接复核为产品税率；请新建目的国细分编码及原产地的人工核定记录",
        );
      const today = businessDay("Asia/Shanghai");
      if (
        i.approved &&
        (!r.data_year ||
          Number(today.slice(0, 4)) - r.data_year > 2 ||
          !r.effective_from ||
          (r.effective_until && r.effective_until < today))
      )
        throw new HttpError(422, "超过两年或过期/缺少生效日，请先修订现行依据");
      await db.query(
        "UPDATE tariff_records SET verification=$2,verified_by=$3,verified_on=now(),review_note=$4,evidence_url=$5 WHERE id=$1",
        [
          r.id,
          i.approved ? "verified" : "rejected",
          req.actor.id,
          i.note,
          i.evidenceUrl,
        ],
      );
      await audit(db, req.actor, "复核税率", r.id, {
        approved: i.approved,
        note: i.note,
        evidenceUrl: i.evidenceUrl,
      });
      return { id: r.id };
    }),
  );
}
