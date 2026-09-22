import { localPostgres } from "./postgres-runtime.ts";
import os from "node:os";
import { hashToken } from "../server/domain.ts";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
if (process.env.NODE_ENV === "production")
  throw new Error("本命令仅用于本地开发。正式环境请配置独立 PostgreSQL。");
const root = path.resolve(".local"),
  credentials = path.join(root, "database.json");
await mkdir(root, { recursive: true });
let password: string;
try {
  password = JSON.parse(await readFile(credentials, "utf8")).password;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  password = randomBytes(32).toString("hex");
  await writeFile(credentials, JSON.stringify({ password }), {
    flag: "wx",
    mode: 0o600,
  });
}
const port = Number(process.env.LOCAL_DB_PORT || 55432),
  dir =
    process.env.LOCAL_DB_DIR ||
    (process.platform === "win32"
      ? path.join(
          os.homedir(),
          "AUTINBERG-CRM-data",
          hashToken(process.cwd()).slice(0, 12),
          "postgres",
        )
      : path.join(root, "postgres")),
  pg = await localPostgres({
    databaseDir: dir,
    port,
    user: "postgres",
    password,
    persistent: true,
    authMethod: "scram-sha-256",
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    postgresFlags: ["-h", "127.0.0.1"],
    onLog: () => {},
    onError: (message) => console.error(String(message)),
  });
try {
  await access(path.join(dir, "PG_VERSION"));
} catch {
  await pg.initialise();
}
await pg.start();
const client = pg.getPgClient();
await client.connect();
if (
  !(await client.query("SELECT 1 FROM pg_database WHERE datname='autinberg'"))
    .rowCount
)
  await pg.createDatabase("autinberg");
await client.end();
try {
  await writeFile(
    ".env",
    `DATABASE_URL=postgresql://postgres:${password}@127.0.0.1:${port}/autinberg\nAPP_ORIGIN=http://127.0.0.1:5173\nPORT=3001\nHOST=127.0.0.1\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log("已生成本地 .env（不含员工账号、不覆盖已有配置）");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  console.log("保留已有 .env，请核对 DATABASE_URL 配置");
}
console.log(
  `本地 PostgreSQL 已启动，端口 ${port}。数据保存在 ${dir}；按 Ctrl+C 停止，数据保留。`,
);
const keepAlive = setInterval(() => {}, 60000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(keepAlive);
    pg.stop().then(() => process.exit(0));
  });
