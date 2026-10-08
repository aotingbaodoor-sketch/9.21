import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type pg from "pg";
import { z } from "zod";
import { backup } from "./backup.ts";
import { transaction } from "./db.ts";
import { nextRun } from "./pricing/sync.ts";

export const backupSchedule = z
  .object({
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.literal("Asia/Shanghai"),
    retentionDays: z.number().int().min(7).max(30),
  })
  .strict();
export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
const MAX_PLAIN_BYTES = 128 * 1024 * 1024,
  LOCK = 825123;
const sha = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
class BackupError extends Error {}
export function backupEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const url = env.BACKUP_STORAGE_URL || "",
    secret = env.BACKUP_STORAGE_KEY || "",
    key = env.BACKUP_ENCRYPTION_KEY || "",
    bucket = "autinberg-crm-backups";
  const missing: string[] = [];
  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url))
    missing.push("BACKUP_STORAGE_URL（Supabase项目HTTPS地址）");
  if (!secret.startsWith("sb_secret_") && !secret.startsWith("eyJ"))
    missing.push("BACKUP_STORAGE_KEY（仅服务端）");
  if (!/^[a-f0-9]{64}$/i.test(key))
    missing.push("BACKUP_ENCRYPTION_KEY（独立256位加密密钥）");
  return {
    url,
    secret,
    key,
    bucket,
    missing,
    keyId: missing.length ? null : sha(Buffer.from(key, "hex")).slice(0, 16),
  };
}
export type BackupEnvironment = ReturnType<typeof backupEnvironment>;
export function encryptBackup(
  archive: Awaited<ReturnType<typeof backup>>,
  key: string,
) {
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new BackupError("备份加密配置无效");
  const plain = Buffer.from(JSON.stringify(archive));
  if (plain.length > MAX_PLAIN_BYTES)
    throw new BackupError("备份超过128MB处理上限，未购买或升级服务");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from("autinberg-cloud-backup-v1"));
  const bytes = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  const output = Buffer.from(
    JSON.stringify({
      format: "autinberg-cloud-backup-v1",
      keyId: sha(Buffer.from(key, "hex")).slice(0, 16),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: bytes.toString("base64"),
    }),
  );
  if (output.length > MAX_BACKUP_BYTES)
    throw new BackupError(
      "加密备份超过16MB安全上限，需评估存储配额；未自动付费",
    );
  return output;
}
export function decryptBackup(
  bytes: Buffer,
  key: string,
): Awaited<ReturnType<typeof backup>> {
  try {
    if (bytes.length > MAX_BACKUP_BYTES) throw new Error();
    const v = JSON.parse(bytes.toString("utf8"));
    if (
      v.format !== "autinberg-cloud-backup-v1" ||
      v.keyId !== sha(Buffer.from(key, "hex")).slice(0, 16)
    )
      throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "hex"),
      Buffer.from(v.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(v.format));
    decipher.setAuthTag(Buffer.from(v.tag, "base64"));
    const archive = JSON.parse(
      gunzipSync(
        Buffer.concat([
          decipher.update(Buffer.from(v.ciphertext, "base64")),
          decipher.final(),
        ]),
        { maxOutputLength: MAX_PLAIN_BYTES },
      ).toString("utf8"),
    );
    if (
      archive.payload?.format !== "autinberg-backup-v1" ||
      archive.sha256 !== sha(JSON.stringify(archive.payload))
    )
      throw new Error();
    return archive;
  } catch {
    throw new BackupError("备份解密或完整性校验失败，已拒绝使用");
  }
}
async function boundedBody(response: Response, max: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new BackupError("存储返回空内容");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      length += r.value.length;
      if (length > max) throw new BackupError("存储响应超过安全上限");
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export function backupStorage(
  config: BackupEnvironment,
  fetcher: typeof fetch = fetch,
) {
  async function request(p: string, method = "GET", body?: Buffer | object) {
    try {
      return await fetcher(config.url + "/storage/v1/" + p, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          apikey: config.secret,
          ...(config.secret.startsWith("eyJ")
            ? { Authorization: "Bearer " + config.secret }
            : {}),
          ...(body
            ? {
                "Content-Type": Buffer.isBuffer(body)
                  ? "application/octet-stream"
                  : "application/json",
              }
            : {}),
        },
        body: body
          ? Buffer.isBuffer(body)
            ? new Uint8Array(body)
            : JSON.stringify(body)
          : undefined,
      });
    } catch {
      throw new BackupError("存储连接失败或超时");
    }
  }
  function requireSuccess(r: Response) {
    if (!r.ok)
      throw new BackupError(
        r.status === 401 || r.status === 403
          ? "存储授权无效，请检查服务端备份密钥"
          : r.status === 413
            ? "存储容量或文件限制阻止备份"
            : `存储请求失败（HTTP ${r.status}）`,
      );
  }
  async function ensurePrivate() {
    let r = await request("bucket/" + config.bucket);
    // Storage may transport its not-found status in JSON with HTTP 400.
    let metadata = JSON.parse((await boundedBody(r, 16000)).toString("utf8"));
    if (r.status === 404 || String(metadata.statusCode) === "404") {
      r = await request("bucket", "POST", {
        id: config.bucket,
        name: config.bucket,
        public: false,
        file_size_limit: MAX_BACKUP_BYTES,
        allowed_mime_types: ["application/octet-stream"],
      });
      requireSuccess(r);
      r = await request("bucket/" + config.bucket);
      metadata = JSON.parse((await boundedBody(r, 16000)).toString("utf8"));
    }
    requireSuccess(r);
    if (metadata.id !== config.bucket || metadata.public !== false)
      throw new BackupError("备份存储桶不是已确认的私有桶，已停止上传");
  }
  const safeKey = (key: string) => {
    if (!/^production\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]{36}\.enc$/.test(key))
      throw new BackupError("备份对象路径不属于本任务");
    return key;
  };
  async function read(key: string) {
    const r = await request(
      "object/authenticated/" + config.bucket + "/" + safeKey(key),
    );
    requireSuccess(r);
    return boundedBody(r, MAX_BACKUP_BYTES);
  }
  return {
    ensurePrivate,
    read,
    async upload(key: string, bytes: Buffer) {
      const r = await request(
        "object/" + config.bucket + "/" + safeKey(key),
        "POST",
        bytes,
      );
      if (!r.ok) {
        if (
          (r.status === 400 || r.status === 409) &&
          sha(await read(key)) === sha(bytes)
        )
          return;
        requireSuccess(r);
      }
    },
    async remove(key: string) {
      const r = await request("object/" + config.bucket, "DELETE", {
        prefixes: [safeKey(key)],
      });
      requireSuccess(r);
      const check = await request(
        "object/authenticated/" + config.bucket + "/" + safeKey(key),
      );
      if (check.ok) throw new BackupError("过期备份删除未确认");
      const result = JSON.parse(
        (await boundedBody(check, 16000)).toString("utf8"),
      );
      if (check.status !== 404 && String(result.statusCode) !== "404")
        throw new BackupError("过期备份删除状态未确认");
    },
  };
}
const safeError = (e: unknown) =>
  e instanceof BackupError
    ? e.message
    : "备份任务失败（未输出凭据或数据库内容），请检查数据库和服务器运行状态";
export function createBackupWorker(
  pool: pg.Pool,
  options: {
    env?: BackupEnvironment;
    fetcher?: typeof fetch;
    retryDelayMs?: number;
  } = {},
) {
  let busy = false;
  async function tick(now = new Date()) {
    if (busy) return;
    busy = true;
    let lock: pg.PoolClient | undefined,
      runId: string | undefined,
      acquired = false;
    try {
      lock = await pool.connect();
      acquired = (
        await lock.query("SELECT pg_try_advisory_lock($1) AS acquired", [LOCK])
      ).rows[0].acquired;
      if (!acquired) return;
      // Session lock spans network operations, but no database transaction is held open.
      const rule = await transaction(pool, async (db) => {
        await db.query(
          "UPDATE automation_rule SET last_heartbeat=$1 WHERE code='cloud_backup'",
          [now],
        );
        const r = (
          await db.query(
            "SELECT * FROM automation_rule WHERE code='cloud_backup' FOR UPDATE",
          )
        ).rows[0];
        if (!r || (!r.enabled && !r.requested_by) || new Date(r.next_run) > now)
          return null;
        await db.query(
          "UPDATE crm_backup_runs SET status='interrupted',finished_at=$1,error='前次进程中断，本次自动恢复' WHERE status='running'",
          [now],
        );
        runId = randomUUID();
        await db.query(
          "INSERT INTO crm_backup_runs(id,rule_code,trigger,requested_by,status,app_version) VALUES($1,'cloud_backup',$2,$3,'running',$4)",
          [
            runId,
            r.requested_by ? "manual" : "scheduled",
            r.requested_by,
            process.env.APP_VERSION ||
              process.env.RAILWAY_GIT_COMMIT_SHA ||
              null,
          ],
        );
        return r;
      });
      if (!rule) return;
      const config = options.env || backupEnvironment(),
        schedule = backupSchedule.parse(rule.config);
      if (config.missing.length)
        throw new BackupError("备份配置缺失：" + config.missing.join("、"));
      const storage = backupStorage(config, options.fetcher),
        archive = await backup(pool),
        bytes = encryptBackup(archive, config.key),
        digest = sha(bytes);
      const objectKey = `production/${archive.payload.createdAt.slice(0, 10)}/${runId}.enc`;
      const recordedBytes=Number((await pool.query('SELECT coalesce(sum(bytes),0) AS bytes FROM crm_backup_runs WHERE deleted_at IS NULL AND object_key IS NOT NULL')).rows[0].bytes);
      if(recordedBytes+bytes.length>256*1024*1024)throw new BackupError('备份存储达到256MB安全预算，请调整保留计划或核对配额；未自动购买升级');
      await pool.query(
        "UPDATE crm_backup_runs SET bucket=$2,object_key=$3,key_id=$4,sha256=$5,snapshot_sha256=$6,bytes=$7,snapshot_at=$8,table_counts=$9 WHERE id=$1",
        [
          runId,
          config.bucket,
          objectKey,
          config.keyId,
          digest,
          archive.sha256,
          bytes.length,
          archive.payload.createdAt,
          JSON.stringify(
            Object.fromEntries(
              Object.entries(archive.payload.tables).map(([t, rows]) => [
                t,
                rows.length,
              ]),
            ),
          ),
        ],
      );
      let error: unknown,
        verified = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await pool.query("UPDATE crm_backup_runs SET attempts=$2 WHERE id=$1", [
          runId,
          attempt,
        ]);
        try {
          await storage.ensurePrivate();
          await storage.upload(objectKey, bytes);
          const returned = await storage.read(objectKey);
          if (
            sha(returned) !== digest ||
            decryptBackup(returned, config.key).sha256 !== archive.sha256
          )
            throw new BackupError("备份回读校验不一致");
          verified = true;
          break;
        } catch (e) {
          error = e;
          if (attempt < 3)
            await new Promise((r) =>
              setTimeout(r, options.retryDelayMs ?? attempt * 1000),
            );
        }
      }
      if (!verified) throw error;
      await transaction(pool, async (db) => {
        await db.query(
          "UPDATE crm_backup_runs SET status='verified',finished_at=now(),verified_at=now() WHERE id=$1",
          [runId],
        );
        await db.query(
          "UPDATE automation_rule SET last_success=now(),last_error=NULL,next_run=$1,requested_by=NULL WHERE code='cloud_backup'",
          [nextRun([schedule.time], new Date())],
        );
      });
      // Only expired objects recorded by this service can be removed, and only after a verified replacement.
      const expired = (
        await pool.query(
          "SELECT id,object_key FROM crm_backup_runs WHERE status<>'running' AND object_key IS NOT NULL AND deleted_at IS NULL AND bucket=$1 AND id<>$2 AND coalesce(verified_at,finished_at,started_at)<now()-($3::int*interval '1 day') ORDER BY started_at LIMIT 50",
          [config.bucket, runId, schedule.retentionDays],
        )
      ).rows;
      for (const prior of expired)
        try {
          await storage.remove(prior.object_key);
          await pool.query(
            "UPDATE crm_backup_runs SET deleted_at=now(),retention_error=NULL WHERE id=$1",
            [prior.id],
          );
        } catch (e) {
          await pool.query(
            "UPDATE crm_backup_runs SET retention_error=$2 WHERE id=$1",
            [prior.id, safeError(e)],
          );
        }
    } catch (e) {
      if (runId)
        await transaction(pool, async (db) => {
          const error = safeError(e);
          await db.query(
            "UPDATE crm_backup_runs SET status='failed',error=$2,finished_at=now() WHERE id=$1 AND status='running'",
            [runId, error],
          );
          await db.query(
            "UPDATE automation_rule SET last_error=$1,next_run=now()+interval '6 hours',requested_by=NULL WHERE code='cloud_backup'",
            [error],
          );
        });
      else throw e;
    } finally {
      if (lock) {
        try {
          if (acquired)
            await lock.query("SELECT pg_advisory_unlock($1)", [LOCK]);
        } finally {
          lock.release();
        }
      }
      busy = false;
    }
  }
  return { tick };
}
