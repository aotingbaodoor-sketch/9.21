import { access, cp, mkdir, unlink, writeFile } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import type EmbeddedPostgres from "embedded-postgres";
type Options = NonNullable<ConstructorParameters<typeof EmbeddedPostgres>[0]>;
const exec = promisify(execFile);

// Windows PostgreSQL 的原生程序使用系统代码页。中文路径会污染 UTF8 初始化脚本。
// 仅本地/测试使用 ASCII 运行目录；生产仍使用独立 PostgreSQL 服务。
export async function localPostgres(options: Options) {
  if (process.platform !== "win32") {
    const { default: Embedded } = await import("embedded-postgres");
    return new Embedded(options);
  }
  if (!options.databaseDir || !options.port || !options.password)
    throw new Error("缺少本地数据库配置");
  if (/[^ -~]/.test(options.databaseDir))
    throw new Error("Windows LOCAL_DB_DIR 需要使用不含中文的持久目录");
  const native = path.resolve(
    path.dirname(
      createRequire(import.meta.url).resolve("@embedded-postgres/windows-x64"),
    ),
    "../native",
  );
  const runtime = path.join(os.tmpdir(), "autinberg-pg18-native");
  if (/[^ -~]/.test(runtime))
    throw new Error("Windows TEMP 路径包含非ASCII字符，请配置英文 TEMP 目录");
  try {
    await access(path.join(runtime, ".ready"));
  } catch {
    await mkdir(runtime, { recursive: true });
    await cp(native, runtime, { recursive: true });
    await writeFile(path.join(runtime, ".ready"), "18");
  }
  const bin = (name: string) => path.join(runtime, "bin", `${name}.exe`);
  let processHandle: ChildProcess | undefined;
  const config = {
    host: "127.0.0.1",
    port: options.port,
    user: options.user || "postgres",
    password: options.password,
    database: "postgres",
    connectionTimeoutMillis: 2000,
  };
  const getPgClient = (name = "postgres") =>
    new pg.Client({ ...config, database: name });
  return {
    getPgClient,
    async initialise() {
      const file = path.join(os.tmpdir(), `autinberg-init-${randomUUID()}.txt`);
      await writeFile(file, options.password + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      try {
        await exec(
          bin("initdb"),
          [
            "-D",
            options.databaseDir!,
            "-U",
            config.user,
            "--pwfile=" + file,
            "--auth=scram-sha-256",
            "--encoding=UTF8",
            "--locale=C",
          ],
          { cwd: runtime, windowsHide: true, timeout: 120000 },
        );
      } finally {
        await unlink(file);
      }
    },
    async start() {
      let logs = "";
      processHandle = spawn(
        bin("postgres"),
        [
          "-D",
          options.databaseDir!,
          "-p",
          String(options.port),
          "-h",
          "127.0.0.1",
        ],
        {
          cwd: runtime,
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      processHandle.stderr?.on("data", (d) => {
        logs = (logs + d.toString()).slice(-5000);
      });
      let spawnError: Error | undefined;
      processHandle.on("error", (error) => {
        spawnError = error;
      });
      for (let attempt = 0; attempt < 40; attempt++) {
        if (spawnError || processHandle.exitCode !== null)
          throw new Error(
            `PostgreSQL 启动失败：${spawnError?.message || logs}`,
          );
        const client = getPgClient();
        try {
          await client.connect();
          await client.query("SELECT 1");
          await client.end();
          return;
        } catch {
          await client.end().catch(() => {});
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      throw new Error("PostgreSQL 启动超时：" + logs);
    },
    async stop() {
      if (!processHandle || processHandle.exitCode !== null) return;
      await exec(
        bin("pg_ctl"),
        ["stop", "-D", options.databaseDir!, "-m", "fast", "-w", "-t", "30"],
        { cwd: runtime, windowsHide: true, timeout: 40000 },
      );
      processHandle = undefined;
    },
    async createDatabase(name: string) {
      if (!/^[a-z][a-z0-9_]+$/.test(name)) throw new Error("数据库名无效");
      const client = getPgClient();
      await client.connect();
      try {
        await client.query(`CREATE DATABASE "${name}"`);
      } finally {
        await client.end();
      }
    },
  };
}
