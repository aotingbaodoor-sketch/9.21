import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { database } from "../server/db.ts";
import { backup, restore } from "../server/backup.ts";
const action = process.argv[2],
  file = process.argv[3];
const url =
  action === "restore"
    ? process.env.RESTORE_DATABASE_URL
    : process.env.DATABASE_URL;
if (!url)
  throw new Error(
    action === "restore"
      ? "必须设置独立目标 RESTORE_DATABASE_URL"
      : "缺少 DATABASE_URL",
  );
if (action === "restore" && url === process.env.DATABASE_URL)
  throw new Error("恢复目标不能与当前业务数据库相同");
const pool = database(url);
try {
  if (action === "backup") {
    const target =
      file ||
      path.join(
        "backups",
        `autinberg-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
    await mkdir(path.dirname(target), { recursive: true });
    const archive = await backup(pool);
    await writeFile(target, JSON.stringify(archive), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      `备份已写入 ${target}；请加密后复制到独立存储。SHA256: ${archive.sha256}`,
    );
  } else if (action === "restore") {
    if (!file || process.env.CONFIRM_RESTORE !== "EMPTY_DATABASE_ONLY")
      throw new Error(
        "请指定备份文件，并设置 CONFIRM_RESTORE=EMPTY_DATABASE_ONLY。目标须先运行迁移且没有业务数据。",
      );
    const counts = await restore(
      pool,
      JSON.parse(await readFile(file, "utf8")),
    );
    console.log("恢复完成（旧会话不恢复）", counts);
  } else throw new Error("用法：backup | restore [文件]");
} finally {
  await pool.end();
}
