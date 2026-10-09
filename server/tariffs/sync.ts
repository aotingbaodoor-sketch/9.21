import type pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { tariffSchedule } from "../../shared/tariffs.ts";
import type { Db } from "../db.ts";
import { nextRun } from "../pricing/sync.ts";
import { ensureSources } from "./sources.ts";
export type Rate = {
  series_key: string;
  country: string;
  origin: string;
  hs_code: string;
  description: string;
  tax_kind: "duty" | "vat" | "extra" | "export_rebate";
  rate_text: string;
  conditions: string;
  effective_from: string | null;
  effective_until: string | null;
  data_year: number | null;
  source_url: string;
  source_published_at: string | null;
  reference_only: boolean;
  raw_data: unknown;
};
const plain = (v: unknown) =>
  String(v ?? "")
    .replace(/<[^>]*>/g, "")
    .trim();
const usRows = z.array(
  z
    .object({
      htsno: z.string(),
      description: z.string(),
      general: z.string().nullish(),
      special: z.string().nullish(),
      other: z.string().nullish(),
    })
    .passthrough(),
);
export function parseUS(data: unknown, url: string, heading: string): Rate[] {
  const rows = usRows.parse(data),
    out: Rate[] = [];
  for (const row of rows) {
    const hs = row.htsno.replace(/\./g, "");
    if (!hs.startsWith(heading) || !/^\d{8,10}$/.test(hs)) continue;
    for (const [column, origin] of [
      ["general", "WORLD"],
      ["special", "QUALIFIED"],
      ["other", "COLUMN2"],
    ] as const) {
      if (!row[column]?.trim()) continue;
      out.push({
        series_key: hs + ":" + column,
        country: "US",
        origin,
        hs_code: hs,
        description: plain(row.description),
        tax_kind: "duty",
        rate_text: plain(row[column]),
        conditions: `HTS ${column} 栏原文。未核实具体原产地、国家细分编码及Chapter 99等附加措施，不是最终应缴税率。`,
        effective_from: null,
        effective_until: null,
        data_year: null,
        source_url: url,
        source_published_at: null,
        reference_only: true,
        raw_data: row,
      });
    }
  }
  if (!out.length)
    throw new Error("接口未返回税率明细（标题/空结果不能视为接通）");
  return out;
}
export function parseWits(raw: unknown, url: string): Rate[] {
  const dimension = z.object({
    id: z.string(),
    values: z.array(z.object({ id: z.string(), name: z.string().optional() })),
  });
  const schema = z.object({
    header: z.object({ id: z.string() }),
    dataSets: z.array(
      z.object({
        series: z.record(
          z.string(),
          z.object({
            observations: z.record(z.string(), z.array(z.unknown())),
          }),
        ),
      }),
    ),
    structure: z.object({
      dimensions: z.object({
        series: z.array(dimension),
        observation: z.array(dimension),
      }),
    }),
  });
  const j = schema.parse(raw);
  if (j.header.id !== "DF_WITS_Tariff_TRAINS")
    throw new Error("返回非税则数据");
  const out: Rate[] = [];
  for (const ds of j.dataSets)
    for (const [key, s] of Object.entries(ds.series)) {
      const parts = key.split(":").map(Number);
      const dims = Object.fromEntries(
        j.structure.dimensions.series.map((d, i) => [d.id, d.values[parts[i]]]),
      );
      if (
        dims.REPORTER?.id !== "840" ||
        dims.PARTNER?.id !== "000" ||
        dims.PRODUCTCODE?.id !== "761010"
      )
        throw new Error("WITS返回查询范围不符");
      for (const [idx, obs] of Object.entries(s.observations)) {
        const year = Number(
          j.structure.dimensions.observation.find((x) => x.id === "TIME_PERIOD")
            ?.values[Number(idx)]?.id,
        );
        if (
          typeof obs[0] !== "number" ||
          !Number.isFinite(obs[0]) ||
          !Number.isInteger(year)
        )
          continue;
        out.push({
          series_key: "US:WORLD:761010:" + year,
          country: "US",
          origin: "WORLD",
          hs_code: "761010",
          description: dims.PRODUCTCODE.name || "761010",
          tax_kind: "duty",
          rate_text: String(obs[0]) + "%",
          conditions:
            "HS6 SimpleAverage 简单平均参考；并非国家细分产品税率，不可用于正式报价。年份为来源年度。",
          effective_from: null,
          effective_until: null,
          data_year: year,
          source_url: url,
          source_published_at: null,
          reference_only: true,
          raw_data: { year, value: obs[0], measure: "SimpleAverage" },
        });
      }
    }
  if (!out.length) throw new Error("接口无可核对的税率数据");
  return out;
}
export async function fetchRates(
  source: string,
  headings: string[],
  http: typeof fetch = fetch,
): Promise<Rate[]> {
  const urls =
    source === "usitc"
      ? headings.map(
          (h) =>
            `https://hts.usitc.gov/reststop/exportList?from=${h}&to=${String(Number(h) + 1).padStart(4, "0")}&format=JSON&styles=false`,
        )
      : source === "wits"
        ? [
            "https://wits.worldbank.org/API/V1/SDMX/V21/datasource/TRN/reporter/840/partner/000/product/761010/year/all/datatype/reported?format=JSON",
          ]
        : [];
  if (!urls.length) throw new Error("此来源没有已验证自动适配器");
  const rates: Rate[] = [];
  for (let i = 0; i < urls.length; i++) {
    const r = await http(urls[i], {
      signal: AbortSignal.timeout(20000),
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`数据源返回 HTTP ${r.status}`);
    const text = await r.text();
    if (text.length > 5e6) throw new Error("数据源响应过大，停止同步");
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("返回非JSON业务数据（可能为登录页或拦截页）");
    }
    rates.push(
      ...(source === "usitc"
        ? parseUS(data, urls[i], headings[i])
        : parseWits(data, urls[i])),
    );
  }
  return rates;
}
export async function saveRate(
  db: Db,
  code: string,
  rate: Rate,
  actorId: string | null = null,
) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    "tariff:" + code + ":" + rate.series_key,
  ]);
  const old = (
    await db.query(
      "SELECT * FROM tariff_records WHERE source_code=$1 AND series_key=$2 AND is_current FOR UPDATE",
      [code, rate.series_key],
    )
  ).rows[0];
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(rate))
    .digest("hex");
  if (old?.fingerprint === fingerprint) {
    await db.query(
      "UPDATE tariff_records SET last_success_at=now() WHERE id=$1",
      [old.id],
    );
    return { id: old.id, changed: false };
  }
  if (old)
    await db.query("UPDATE tariff_records SET is_current=false WHERE id=$1", [
      old.id,
    ]);
  const id = randomUUID();
  const columns = Object.keys(rate);
  const values = Object.values(rate).map((v, i) =>
    columns[i] === "raw_data" ? JSON.stringify(v) : v,
  );
  await db.query(
    `INSERT INTO tariff_records(id,source_code,version,fingerprint,hs_level,created_by,${columns.join(",")}) VALUES(${[id, code, (old?.version || 0) + 1, fingerprint, rate.hs_code.length, actorId, ...values].map((_, i) => "$" + (i + 1)).join(",")})`,
    [
      id,
      code,
      (old?.version || 0) + 1,
      fingerprint,
      rate.hs_code.length,
      actorId,
      ...values,
    ],
  );
  // A source change invalidates related manually verified current entries, not previously issued quote snapshots.
  if (old || rate.reference_only)
    await db.query(
      "UPDATE tariff_records SET verification='pending',verified_by=NULL,verified_on=NULL,review_note='来源变化，需重新复核' WHERE source_code=$1 AND left(hs_code,6)=$2 AND is_current AND verification='verified'",
      [code, rate.hs_code.slice(0, 6)],
    );
  return { id, changed: true };
}
export function createTariffWorker(pool: pg.Pool, http: typeof fetch = fetch) {
  let busy = false;
  return {
    async tick() {
      if (busy) return;
      busy = true;
      const db = await pool.connect().catch((e) => {
        busy = false;
        throw e;
      });
      let locked = false;
      try {
        locked = (await db.query("SELECT pg_try_advisory_lock(940924) ok"))
          .rows[0].ok;
        if (!locked) return;
        await ensureSources(db);
        await db.query(
          "UPDATE automation_rule SET last_heartbeat=now() WHERE code='tariff_sync'",
        );
        const rule = (
          await db.query(
            "SELECT *,next_run<=now() due FROM automation_rule WHERE code='tariff_sync'",
          )
        ).rows[0];
        if (!rule || (!rule.enabled && !rule.requested_by) || !rule.due) return;
        const config = tariffSchedule.parse(rule.config);
        await db.query(
          "UPDATE tariff_sync_runs SET status='interrupted',error='服务重启中断；本次将重试',finished_at=now() WHERE status='running'",
        );
        const sources = (
          await db.query(
            "SELECT code FROM tariff_source_registry WHERE enabled AND code IN ('usitc','wits') ORDER BY code",
          )
        ).rows;
        const errors: string[] = [];
        for (const source of sources) {
          const runId = randomUUID();
          await db.query(
            "INSERT INTO tariff_sync_runs(id,source_code,status) VALUES($1,$2,'running')",
            [runId, source.code],
          );
          let succeeded = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            if (attempt > 1) await delay(attempt * 500);
            await db.query(
              "UPDATE tariff_sync_runs SET attempts=$2 WHERE id=$1",
              [runId, attempt],
            );
            try {
              const rates = await fetchRates(
                source.code,
                config.usHeadings,
                http,
              );
              let changed = 0;
              await db.query("BEGIN");
              for (const rate of rates)
                if ((await saveRate(db, source.code, rate)).changed) changed++;
              // Removed official measures cease to be selectable. Preserve every old version.
              const removed = await db.query(
                "UPDATE tariff_records SET is_current=false WHERE source_code=$1 AND is_current AND reference_only AND NOT(series_key=ANY($2::text[])) RETURNING hs_code",
                [source.code, rates.map((r) => r.series_key)],
              );
              for (const row of removed.rows)
                await db.query(
                  "UPDATE tariff_records SET verification='pending',verified_by=NULL,verified_on=NULL,review_note='来源措施已撤下，请重新复核' WHERE source_code=$1 AND left(hs_code,6)=$2 AND is_current AND verification='verified'",
                  [source.code, row.hs_code.slice(0, 6)],
                );
              await db.query(
                "UPDATE tariff_source_registry SET status='connected',checked_at=now(),last_success_at=now(),last_error=NULL WHERE code=$1",
                [source.code],
              );
              await db.query(
                "UPDATE tariff_sync_runs SET status=$2,records=$3,changed=$4,finished_at=now(),request_url=$5 WHERE id=$1",
                [
                  runId,
                  changed ? "success" : "unchanged",
                  rates.length,
                  changed,
                  rates[0].source_url,
                ],
              );
              await db.query("COMMIT");
              succeeded = true;
              break;
            } catch (e) {
              await db.query("ROLLBACK");
              const safe =
                e instanceof Error &&
                /^(数据源|返回非JSON|接口|此来源|WITS)/.test(e.message)
                  ? e.message
                  : "网络或数据结构异常；未输出原始响应";
              if (attempt === 3) {
                errors.push(source.code + ": " + safe);
                await db.query(
                  "UPDATE tariff_sync_runs SET status='failed',error=$2,finished_at=now() WHERE id=$1",
                  [runId, safe],
                );
                await db.query(
                  "UPDATE tariff_source_registry SET status='failed',checked_at=now(),last_error=$2 WHERE code=$1",
                  [source.code, safe],
                );
              }
            }
          }
          if (!succeeded) continue;
        }
        await db.query(
          "UPDATE automation_rule SET next_run=$1,requested_by=NULL,last_error=$2,last_success=CASE WHEN $2::text IS NULL THEN now() ELSE last_success END WHERE code='tariff_sync'",
          [nextRun([config.time]), errors.length ? errors.join("；") : null],
        );
      } finally {
        if (locked) await db.query("SELECT pg_advisory_unlock(940924)");
        db.release();
        busy = false;
      }
    },
  };
}
