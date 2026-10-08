// Explicitly isolated restore only. Never prints credentials or the decrypted archive.
import { readFile } from "node:fs/promises";
import { database } from "../server/db.ts";
import { decryptBackup } from "../server/cloud-backup.ts";
import { restore } from "../server/backup.ts";
const url = process.env.RESTORE_DATABASE_URL;
if (
  !url ||
  !process.argv[2] ||
  process.env.CONFIRM_RESTORE !== "EMPTY_DATABASE_ONLY" ||
  url === process.env.DATABASE_URL
)
  throw new Error("必须提供加密文件、独立空库及 EMPTY_DATABASE_ONLY 确认");
// Reject aliases of the source DB, not just identical URL strings.
if (process.env.DATABASE_URL) {
  const a = new URL(url),
    b = new URL(process.env.DATABASE_URL);
  if (
    a.hostname === b.hostname &&
    a.port === b.port &&
    a.pathname === b.pathname
  )
    throw new Error("禁止向生产数据库恢复");
}
const pool = database(url);
try {
  const archive = decryptBackup(
    await readFile(process.argv[2]),
    process.env.BACKUP_ENCRYPTION_KEY || "",
  );
  const counts = await restore(pool, archive);
  console.log(
    JSON.stringify({
      restored: true,
      sourceCreatedAt: archive.payload.createdAt,
      counts,
    }),
  );
} catch {
  console.error(
    "恢复失败；目标必须为空库且迁移版本、密钥与备份一致。未输出秘密。",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
