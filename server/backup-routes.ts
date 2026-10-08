import type { Express, Request, Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { backupEnvironment, backupSchedule } from "./cloud-backup.ts";
import { requireAdmin, HttpError } from "./domain.ts";
import { audit } from "./repository.ts";
import { nextRun } from "./pricing/sync.ts";
type Mutate = (
  req: Request,
  res: Response,
  run: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;
export function registerBackup(app: Express, pool: pg.Pool, mutate: Mutate) {
  app.use("/api/backups", (req, _res, next) => {
    requireAdmin(req.actor);
    next();
  });
  app.get("/api/backups/alerts/count", async (_req, res) =>
    res.json(
      (
        await pool.query(
          "SELECT ((SELECT count(*) FROM automation_rule WHERE code='cloud_backup' AND last_error IS NOT NULL)+(SELECT count(*) FROM crm_backup_runs WHERE retention_error IS NOT NULL AND deleted_at IS NULL))::int AS count",
        )
      ).rows[0],
    ),
  );
  app.get("/api/backups", async (_req, res) => {
    const [rules, runs] = await Promise.all([
      pool.query(
        "SELECT enabled,config,version,next_run,last_heartbeat,last_success,last_error FROM automation_rule WHERE code='cloud_backup'",
      ),
      pool.query(
        "SELECT id,trigger,status,started_at,finished_at,attempts,error,bucket,object_key,key_id,sha256,bytes,app_version,table_counts,snapshot_at,verified_at,deleted_at,retention_error FROM crm_backup_runs ORDER BY started_at DESC LIMIT 30",
      ),
    ]);
    const env = backupEnvironment();
    res.json({
      rule: rules.rows[0],
      runs: runs.rows,
      storage: {
        url: env.url,
        bucket: env.bucket,
        keyId: env.keyId,
        missing: env.missing,
      },
      scope:
        "业务数据库全量快照，包含已存数据库的附件、账号哈希及加密渠道凭据；不包含会话、环境密钥和外部链接指向的文件。恢复仅限隔离空库。",
    });
  });
  app.put("/api/backups/config", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const input = z
        .object({
          enabled: z.boolean(),
          config: backupSchedule,
          version: z.number().int(),
        })
        .strict()
        .parse(req.body);
      const r = await db.query(
        "UPDATE automation_rule SET enabled=$1,config=$2,version=version+1,next_run=$3,updated_by=$4,updated_at=now() WHERE code='cloud_backup' AND version=$5 RETURNING version",
        [
          input.enabled,
          JSON.stringify(input.config),
          nextRun([input.config.time]),
          req.actor.id,
          input.version,
        ],
      );
      if (!r.rowCount) throw new HttpError(409, "备份配置已变化，请刷新后重试");
      await audit(db, req.actor, "修改云端备份计划", "cloud_backup", {
        enabled: input.enabled,
        ...input.config,
      });
      return r.rows[0];
    }),
  );
  app.post("/api/backups/run", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const env = backupEnvironment();
      if (env.missing.length)
        throw new HttpError(422, "备份尚未就绪：" + env.missing.join("、"));
      const rule = (
        await db.query(
          "SELECT * FROM automation_rule WHERE code='cloud_backup' FOR UPDATE",
        )
      ).rows[0];
      if (
        rule.requested_by ||
        (await db.query("SELECT 1 FROM crm_backup_runs WHERE status='running'"))
          .rowCount
      )
        return { queued: false, message: "备份已在排队或执行中" };
      await db.query(
        "UPDATE automation_rule SET next_run=now(),requested_by=$1 WHERE code='cloud_backup'",
        [req.actor.id],
      );
      await audit(db, req.actor, "请求云端加密备份", "cloud_backup");
      return {
        queued: true,
        message: "服务器将在一分钟内执行，关闭浏览器不影响任务",
      };
    }),
  );
}
