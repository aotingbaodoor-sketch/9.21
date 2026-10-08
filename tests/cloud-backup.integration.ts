// Actual backup, restore, scheduler, migration and API implementation; isolated DB + deterministic storage fault injection.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { localPostgres } from "../scripts/postgres-runtime.ts";
import { database, migrate } from "../server/db.ts";
import { backup, restore } from "../server/backup.ts";
import {
  backupEnvironment,
  backupStorage,
  createBackupWorker,
  decryptBackup,
  encryptBackup,
} from "../server/cloud-backup.ts";
import { createApp } from "../server/app.ts";
import { hashPassword } from "../server/domain.ts";
const root = mkdtempSync(path.join(os.tmpdir(), "autinberg-backup-")),
  password = randomBytes(32).toString("hex"),
  key = randomBytes(32).toString("hex");
const local = await localPostgres({
  databaseDir: path.join(root, "pg"),
  port: 55623,
  user: "postgres",
  password,
  persistent: true,
  fastIsolatedInit: true,
  onLog: () => {},
  onError: () => {},
});
const pool = database(
    `postgresql://postgres:${password}@127.0.0.1:55623/backup_test`,
  ),
  target = database(
    `postgresql://postgres:${password}@127.0.0.1:55623/restore_test`,
  );
const config = backupEnvironment({
  BACKUP_STORAGE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  BACKUP_STORAGE_KEY: "sb_secret_isolated_test_only",
  BACKUP_ENCRYPTION_KEY: key,
});
const files = new Map<string, Buffer>();
let publicBucket = false,
  failures = 0,
  bucketExists = false,
  deletes = 0,
  server: Server | undefined;
const result: { name: string; status: string }[] = [];
const pass = (name: string) => {
  result.push({ name, status: "passed" });
  console.log("PASS", name);
};
const mockFetch: typeof fetch = async (input, init) => {
  assert.equal(new Headers(init?.headers).get("apikey"), config.secret);
  assert.equal(init?.redirect, "error");
  const url = new URL(String(input)),
    p = url.pathname.replace("/storage/v1/", "");
  if (failures > 0) {
    failures--;
    throw new Error("network secret " + config.secret);
  }
  if (p === "bucket/" + config.bucket)
    return Response.json(
      bucketExists
        ? { id: config.bucket, public: publicBucket }
        : { statusCode: "404" },
      { status: bucketExists ? 200 : 400 },
    );
  if (p === "bucket" && init?.method === "POST") {
    assert.equal(JSON.parse(String(init.body)).public, false);
    bucketExists = true;
    return Response.json({ name: config.bucket });
  }
  if (p === "object/" + config.bucket && init?.method === "DELETE") {
    for (const name of JSON.parse(String(init.body)).prefixes) {
      files.delete(name);
      deletes++;
    }
    return Response.json([]);
  }
  if (p.startsWith("object/authenticated/" + config.bucket + "/")) {
    const file = files.get(
      p.slice(("object/authenticated/" + config.bucket + "/").length),
    );
    return file
      ? new Response(new Uint8Array(file))
      : Response.json({ statusCode: "404" }, { status: 400 });
  }
  if (
    p.startsWith("object/" + config.bucket + "/") &&
    init?.method === "POST"
  ) {
    const name = p.slice(("object/" + config.bucket + "/").length);
    if (files.has(name))
      return Response.json({ statusCode: "409" }, { status: 400 });
    files.set(name, Buffer.from(init.body as Uint8Array));
    return Response.json({ Key: name });
  }
  throw new Error("Unknown storage path");
};
const origin = "http://127.0.0.1:4623";
type Actor = { cookie: string; csrf: string };
async function request(
  actor: Actor | null,
  url: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  id = randomUUID(),
) {
  const r = await fetch(origin + "/api" + url, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": id,
      ...(actor ? { Cookie: actor.cookie, "X-CSRF-Token": actor.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: r.status,
    data: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
  };
}
async function due() {
  await pool.query(
    "UPDATE automation_rule SET next_run=now()-interval '1 second' WHERE code='cloud_backup'",
  );
}
try {
  await local.initialise();
  await local.start();
  await local.createDatabase("backup_test");
  await local.createDatabase("restore_test");
  await migrate(pool);
  await migrate(target);
  const adminId = randomUUID(),
    hash = await hashPassword(password);
  await pool.query(
    "INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES($1,'Backup Admin','admin@backup.invalid',$2,'admin','2026-01-01 12:34:56.123456+00')",
    [adminId, hash],
  );
  await pool.query(
    "INSERT INTO users(id,name,email,password_hash,role) VALUES($1,'Sales','sales@backup.invalid',$2,'sales')",
    [randomUUID(), hash],
  );
  Object.assign(process.env, {
    BACKUP_STORAGE_URL: config.url,
    BACKUP_STORAGE_KEY: config.secret,
    BACKUP_ENCRYPTION_KEY: key,
  });
  const app = createApp(pool, {
    origin,
    serveStatic: process.argv.includes("--ui"),
  });
  if (process.argv.includes("--ui")) {
    await cp(path.resolve("dist"), path.join(root, "dist"), {
      recursive: true,
    });
    process.chdir(root);
  }
  server = app.listen(4623, "127.0.0.1");
  const a = await request(null, "/auth/login", {
      email: "admin@backup.invalid",
      password,
    }),
    s = await request(null, "/auth/login", {
      email: "sales@backup.invalid",
      password,
    });
  const admin = { cookie: a.cookie, csrf: a.data.csrf },
    sales = { cookie: s.cookie, csrf: s.data.csrf };
  assert.equal((await request(sales, "/backups")).status, 403);
  assert.equal((await request(sales, "/backups/run", {})).status, 403);
  assert.equal((await request(null, "/backups")).status, 401);
  assert.equal((await request({...admin,csrf:''},'/backups/run',{})).status,403);
  pass(
    "backup API authenticates, CSRF protects mutations and sales cannot read or operate",
  );
  const worker = createBackupWorker(pool, {
    env: config,
    fetcher: mockFetch,
    retryDelayMs: 0,
  });
  await Promise.all(
    Array.from({ length: 20 }, () =>
      createBackupWorker(pool, {
        env: config,
        fetcher: mockFetch,
        retryDelayMs: 0,
      }).tick(),
    ),
  );
  let rows = (await pool.query("SELECT * FROM crm_backup_runs")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "verified");
  assert.equal(files.size, 1);
  pass(
    "20 simultaneous workers create one encrypted backup and private bucket",
  );
  const bytes = files.get(rows[0].object_key)!;
  assert(!bytes.includes(Buffer.from("admin@backup.invalid")));
  const archive = decryptBackup(bytes, key);
  const backedTime = String(
    archive.payload.tables.users.find((u) => u.id === adminId)?.created_at,
  );
  assert.match(backedTime, /\.123456[+-]/);
  assert.equal(new Date(backedTime).toISOString(), "2026-01-01T12:34:56.123Z");
  assert.throws(() => decryptBackup(bytes, randomBytes(32).toString("hex")));
  const tampered = JSON.parse(bytes.toString());
  tampered.tag = Buffer.alloc(16).toString("base64");
  assert.throws(() =>
    decryptBackup(Buffer.from(JSON.stringify(tampered)), key),
  );
  await restore(target, archive);
  assert.equal(
    (
      await target.query(
        "SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS exact_time FROM users WHERE id=$1",
        [adminId],
      )
    ).rows[0].exact_time,
    "2026-01-01 12:34:56.123456",
  );
  await assert.rejects(() => restore(target, archive));
  pass(
    "AES-GCM tamper/wrong key rejected; real isolated restore retains microseconds and refuses nonempty DB",
  );
  failures = 2;
  await due();
  await worker.tick();
  rows = (
    await pool.query("SELECT * FROM crm_backup_runs ORDER BY started_at DESC")
  ).rows;
  assert.equal(rows[0].status, "verified");
  assert.equal(rows[0].attempts, 3);
  pass("transient storage failures retry three times and verify readback");
  publicBucket = true;
  await due();
  await worker.tick();
  rows = (
    await pool.query("SELECT * FROM crm_backup_runs ORDER BY started_at DESC")
  ).rows;
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error, /私有桶/);
  assert.equal(files.size, 2);
  assert.equal((await request(admin, "/backups/alerts/count")).data.count, 1);
  publicBucket = false;
  pass("public storage rejected, last good files retained and admin alerted");
  const cfg = await request(admin, "/backups");
  assert(!JSON.stringify(cfg.data).includes(config.secret));
  assert(!JSON.stringify(cfg.data).includes(key));
  await request(
    admin,
    "/backups/config",
    {
      enabled: true,
      version: cfg.data.rule.version,
      config: { time: "04:15", timezone: "Asia/Shanghai", retentionDays: 7 },
    },
    "PUT",
  );
  assert.equal(
    (await request(admin, "/backups")).data.rule.config.time,
    "04:15",
  );
  const idem = randomUUID();
  const x = await request(admin, "/backups/run", {}, "POST", idem),
    y = await request(admin, "/backups/run", {}, "POST", idem);
  assert.deepEqual(x.data, y.data);
  await worker.tick();
  assert.equal((await request(admin, "/backups/alerts/count")).data.count, 0);
  pass(
    "admin config effective without restart, manual request idempotent, success resolves alert, secrets absent from API",
  );
  const prior = (
    await pool.query(
      "SELECT id,object_key FROM crm_backup_runs WHERE status='verified' ORDER BY started_at LIMIT 1",
    )
  ).rows[0];
  await pool.query(
    "UPDATE crm_backup_runs SET verified_at=now()-interval '20 days' WHERE id=$1",
    [prior.id],
  );
  await due();
  await worker.tick();
  assert.equal(deletes, 1);
  assert(!files.has(prior.object_key));
  pass(
    "retention deletes only recorded expired file after replacement verifies",
  );
  await assert.rejects(() =>
    backupStorage(config, mockFetch).remove("../users"),
  );
  const fresh = await backup(pool);
  assert.equal(
    decryptBackup(encryptBackup(fresh, key), key).sha256,
    fresh.sha256,
  );
  const budgetRow=(await pool.query("SELECT id,bytes FROM crm_backup_runs WHERE status='verified' AND deleted_at IS NULL ORDER BY started_at DESC LIMIT 1")).rows[0];
  await pool.query('UPDATE crm_backup_runs SET bytes=268435456 WHERE id=$1',[budgetRow.id]);await due();const fileCount=files.size;await worker.tick();assert.equal(files.size,fileCount);assert.match((await request(admin,'/backups')).data.rule.last_error,/256MB/);await pool.query('UPDATE crm_backup_runs SET bytes=$2 WHERE id=$1',[budgetRow.id,budgetRow.bytes]);pass('storage safety budget blocks further uploads without purchasing upgrades');
  const bad = createBackupWorker(pool, {
    env: backupEnvironment({}),
    fetcher: mockFetch,
    retryDelayMs: 0,
  });
  await due();
  await bad.tick();
  assert.match(
    (await request(admin, "/backups")).data.rule.last_error,
    /配置缺失/,
  );
  pass("missing configuration and unsafe object paths blocked");
  if (process.argv.includes("--ui")) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      channel: "msedge",
      headless: true,
    });
    try {
      const page = await browser.newPage({
          viewport: { width: 1440, height: 1000 },
        }),
        errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(origin + "/settings/backups");
      await page
        .getByLabel("邮箱", { exact: true })
        .fill("admin@backup.invalid");
      await page.getByLabel("密码", { exact: true }).fill(password);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page
        .getByRole("heading", { name: "9.6 云端备份与隔离恢复" })
        .waitFor();
      await page.getByText("最近执行记录", { exact: true }).waitFor();
      await page.getByLabel("每日时间（北京时间）").fill("05:15");
      await page.getByRole("button", { name: "保存计划", exact: true }).click();
      await page.waitForResponse(
        (r) => r.url().endsWith("/api/backups") && r.ok(),
      );
      await page.reload();
      await page
        .getByRole("heading", { name: "9.6 云端备份与隔离恢复" })
        .waitFor();
      assert.equal(
        await page.getByLabel("每日时间（北京时间）").inputValue(),
        "05:15",
      );
      assert.equal(new URL(page.url()).pathname, "/settings/backups");
      assert.match(await page.title(), /CRM/);
      assert.deepEqual(errors, []);
      await page.screenshot({
        path: "C:/Users/HUAWEI/Documents/AUTINBERG-Deliveries/fulfillment-20261005/evidence/backups-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile page must not overflow horizontally');
      await page.screenshot({
        path: "C:/Users/HUAWEI/Documents/AUTINBERG-Deliveries/fulfillment-20261005/evidence/backups-mobile.png",
        fullPage: true,
      });
      pass(
        "real admin browser saves schedule, refresh preserves it; desktop/mobile and console checks pass",
      );
    } finally {
      await browser.close();
    }
  }
  console.log(
    JSON.stringify({
      passed: result.length,
      failed: 0,
      scope:
        "isolated actual CRM; storage transport mocked, not a real-cloud claim",
    }),
  );
  writeFileSync(
    "C:/Users/HUAWEI/Documents/AUTINBERG-Deliveries/fulfillment-20261005/evidence/backup-tests.json",
    JSON.stringify({ result, createdAt: new Date().toISOString() }, null, 2),
  );
} finally {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await pool.end();
  await target.end();
  await local.stop();
}
