import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";
import { localPostgres } from "../scripts/postgres-runtime.ts";
import { chromium, expect } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { database, migrate } from "../server/db.ts";
import { createApp } from "../server/app.ts";
import { businessDay, addDays } from "../server/domain.ts";
import { backup, restore } from "../server/backup.ts";
import type { Customer, Summary, User } from "../shared/contracts.ts";

const runId = randomUUID(),
  password = randomBytes(24).toString("base64url"),
  dbPassword = randomBytes(24).toString("hex"),
  root = path.resolve(".test-data", runId),
  port = 55439,
  origin = "http://127.0.0.1:4399";
const artifacts =
  process.env.ARTIFACT_DIR || path.join(os.tmpdir(), "autinberg-qa", runId);
await mkdir(root, { recursive: true });
await mkdir(artifacts, { recursive: true });
const pg = await localPostgres({
  databaseDir:
    process.platform === "win32"
      ? path.join(os.tmpdir(), "autinberg-test-db", runId, "postgres")
      : path.join(root, "postgres"),
  port,
  user: "postgres",
  password: dbPassword,
  persistent: true,
  authMethod: "scram-sha-256",
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: () => {},
  onError: () => {},
});
let pool = database(
    `postgresql://postgres:${dbPassword}@127.0.0.1:${port}/crm_test`,
  ),
  server: Server | undefined,
  browser: Browser | undefined,
  started = false;
const completed: string[] = [];
const pass = (name: string) => {
  completed.push(name);
  console.log(`PASS ${name}`);
};
const closeServer = () =>
  new Promise<void>((resolve, reject) =>
    server
      ? server.close((error) => (error ? reject(error) : resolve()))
      : resolve(),
  );
type Agent = { cookie: string; csrf: string; user: User };
async function request(
  agent: Agent | null,
  url: string,
  method = "GET",
  body?: unknown,
  key: string = randomUUID(),
) {
  const response = await fetch(`${origin}/api${url}`, {
    method,
    headers: {
      Origin: origin,
      ...(agent ? { Cookie: agent.cookie, "X-CSRF-Token": agent.csrf } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "Idempotency-Key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie"),
  };
}
async function ok(
  agent: Agent | null,
  url: string,
  method = "GET",
  body?: unknown,
  key?: string,
) {
  const r = await request(agent, url, method, body, key);
  assert.equal(r.status, 200, `${method} ${url}: ${JSON.stringify(r.data)}`);
  return r.data;
}
async function login(email: string): Promise<Agent> {
  const r = await request(null, "/auth/login", "POST", { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return {
    cookie: r.cookie!.split(";")[0],
    csrf: r.data.csrf,
    user: r.data.user,
  };
}
function editInput(c: Customer, changes: Record<string, unknown> = {}) {
  return {
    company: c.company,
    contact: c.contact,
    country: c.country,
    city: c.city,
    phone: c.phone,
    whatsapp: c.whatsapp,
    email: c.email,
    website: c.website,
    grade: c.grade,
    stage: c.stage,
    product: c.product,
    inquiry: c.inquiry,
    quantity: c.quantity,
    estimatedValue: c.estimatedValue,
    currency: c.currency,
    source: c.source,
    notes: c.notes,
    tags: c.tags,
    ownerId: c.ownerId,
    next: c.next,
    version: c.version,
    ...changes,
  };
}
async function startServer() {
  const app = createApp(pool, { origin, serveStatic: true });
  server = app.listen(4399, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
}
async function browserLogin(page: Page, email: string) {
  await page.goto(origin + "/login");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: /你好/ })).toBeVisible();
}

try {
  console.log("正在初始化隔离 PostgreSQL（ASCII 路径）");
  await pg.initialise();
  console.log("数据库初始化完成，启动测试服务");
  await pg.start();
  started = true;
  await pg.createDatabase("crm_test");
  await pg.createDatabase("crm_restore");
  await migrate(pool);
  await migrate(pool);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n,
    0,
  );
  const initializeAdmin = () =>
    promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "scripts/create-admin.ts"],
      {
        windowsHide: true,
        env: {
          ...process.env,
          DATABASE_URL: `postgresql://postgres:${dbPassword}@127.0.0.1:${port}/crm_test`,
          ADMIN_NAME: "验收管理员",
          ADMIN_EMAIL: "admin@test.invalid",
          ADMIN_PASSWORD: password,
        },
      },
    );
  await initializeAdmin();
  await assert.rejects(initializeAdmin, /管理员已存在/);
  pass("空库无自动演示账号，管理员初始化命令可执行且拒绝重复覆盖");
  await startServer();
  const admin = await login("admin@test.invalid");
  const aId = (
    await ok(admin, "/team", "POST", {
      name: "销售A",
      email: "a@test.invalid",
      password,
      role: "sales",
    })
  ).id;
  const bId = (
    await ok(admin, "/team", "POST", {
      name: "销售B",
      email: "b@test.invalid",
      password,
      role: "sales",
    })
  ).id;
  let a = await login("a@test.invalid");
  const b = await login("b@test.invalid");
  assert.equal((await request(null, "/customers")).status, 401);
  assert.equal((await request(a, "/team")).status, 403);
  assert.equal(
    (
      await request(a, "/team", "POST", {
        name: "闯入管理员",
        email: "bad@test.invalid",
        password,
        role: "admin",
      })
    ).status,
    403,
  );
  let ca: Customer = await ok(admin, "/customers", "POST", {
    company: "Alpha Test Building",
    contact: "Test Contact A",
    grade: "A",
    country: "英国",
    product: "铝合金平开窗",
    ownerId: aId,
    tags: ["VIP"],
  });
  const cb: Customer = await ok(admin, "/customers", "POST", {
    company: "Beta Private Building",
    contact: "Test Contact B",
    grade: "B",
    country: "法国",
    ownerId: bId,
  });
  assert.equal((await ok(a, "/customers")).total, 1);
  assert.equal((await ok(b, "/customers")).total, 1);
  pass("管理员创建独立员工、分配客户，销售分别登录只见自己的数据");
  for (const [url, method, body] of [
    [`/customers/${cb.id}`, "GET", undefined],
    [`/customers/${cb.id}`, "PUT", editInput(cb, { company: "入侵" })],
    [
      `/customers/${cb.id}/follow-ups`,
      "POST",
      { version: cb.version, method: "电话", content: "入侵" },
    ],
  ] as [string, string, unknown][]) {
    assert.equal((await request(a, url, method, body)).status, 404);
  }
  assert.equal(
    (
      await request(a, `/customers/${ca.id}/delete`, "POST", {
        version: ca.version,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        a,
        `/customers/${ca.id}`,
        "PUT",
        editInput(ca, { ownerId: bId }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(a, "/customers", "POST", {
        company: "越权分配",
        ownerId: bId,
      })
    ).status,
    403,
  );
  assert.equal((await ok(a, "/customers?q=Beta")).total, 0);
  assert.equal((await ok(a, `/records?customerId=${cb.id}`)).total, 0);
  assert.equal(((await ok(a, "/summary")) as Summary).metrics.total, 1);
  assert.ok(
    (await ok(a, "/export")).customers.every(
      (c: Customer) => c.ownerId === aId,
    ),
  );
  assert.ok(
    (await ok(a, "/notifications")).every(
      (n: { customerId: string }) => n.customerId === ca.id,
    ),
  );
  const bNotice = (await ok(b, "/notifications"))[0];
  const aNotice = (await ok(a, "/notifications"))[0];
  await ok(admin, `/notifications/${aNotice.id}/read`, "POST", { read: true });
  assert.equal(
    (await ok(a, "/notifications")).find(
      (n: { id: string }) => n.id === aNotice.id,
    ).readAt,
    null,
  );
  await ok(a, `/notifications/${aNotice.id}/read`, "POST", { read: true });
  assert.ok(
    (await ok(a, "/notifications")).find(
      (n: { id: string }) => n.id === aNotice.id,
    ).readAt,
  );
  assert.equal(
    (
      await request(a, `/notifications/${bNotice.id}/read`, "POST", {
        read: true,
      })
    ).status,
    404,
  );
  assert.equal((await request(a, "/audit")).status, 403);
  assert.equal((await request(a, "/import/preview", "POST", {})).status, 403);
  await ok(b, `/customers/${cb.id}/follow-ups`, "POST", {
    version: cb.version,
    method: "Email",
    content: "B专属跟进，不得泄露给A",
  });
  assert.equal((await ok(b, `/records?customerId=${cb.id}`)).total, 1);
  assert.equal((await ok(a, `/records?customerId=${cb.id}`)).total, 0);
  assert.equal((await ok(a, "/records")).total, 0);
  assert.equal((await ok(a, "/export")).records.length, 0);
  pass("详情、搜索、统计、提醒、历史、导出及写接口全部按负责人隔离");
  const today = businessDay("Asia/Shanghai"),
    key = randomUUID(),
    follow = {
      version: ca.version,
      method: "WhatsApp",
      content: "确认门窗尺寸",
      response: "等待报价",
      plan: "发送正式报价",
    };
  const record = await ok(
    a,
    `/customers/${ca.id}/follow-ups`,
    "POST",
    follow,
    key,
  );
  assert.equal(record.next, addDays(today, 1));
  assert.deepEqual(
    await ok(a, `/customers/${ca.id}/follow-ups`, "POST", follow, key),
    record,
  );
  let detail = await ok(a, `/customers/${ca.id}`);
  ca = detail.customer;
  assert.equal(detail.records.total, 1);
  assert.equal(detail.records.items[0].response, "等待报价");
  assert.ok(ca.last);
  assert.equal((await ok(a, "/customers?status=今日已完成")).total, 1);
  await pool.query("UPDATE customers SET next_follow_up=$2 WHERE id=$1", [
    ca.id,
    today,
  ]);
  assert.equal(
    (await ok(a, `/customers/${ca.id}`)).customer.status,
    "今日跟进",
  );
  await pool.query("UPDATE customers SET next_follow_up=$2 WHERE id=$1", [
    ca.id,
    addDays(today, -2),
  ]);
  assert.equal((await ok(a, `/customers/${ca.id}`)).customer.overdueDays, 2);
  assert.equal((await ok(a, "/customers?status=已逾期")).total, 1);
  let config = await ok(admin, "/settings");
  config = await ok(admin, "/settings", "PUT", {
    ...config,
    cycles: { ...config.cycles, A: 2 },
  });
  ca = (await ok(a, `/customers/${ca.id}`)).customer;
  assert.equal(
    (
      await ok(a, `/customers/${ca.id}/follow-ups`, "POST", {
        ...follow,
        version: ca.version,
        content: "管理员改为2天周期",
      })
    ).next,
    addDays(today, 2),
  );
  ca = (await ok(a, `/customers/${ca.id}`)).customer;
  assert.equal(
    (
      await ok(a, `/customers/${ca.id}/follow-ups`, "POST", {
        ...follow,
        version: ca.version,
        next: addDays(today, 9),
        content: "手动日期",
      })
    ).next,
    addDays(today, 9),
  );
  assert.equal((await request(a, "/settings", "PUT", config)).status, 403);
  pass("A级自动日期、手动日期优先、可配置周期、今日/逾期及重复提交原子性");
  ca = (await ok(a, `/customers/${ca.id}`)).customer;
  const stale = editInput(ca, { notes: "过时版本" });
  ca = await ok(
    a,
    `/customers/${ca.id}`,
    "PUT",
    editInput(ca, { notes: "最新版本", grade: "B", stage: "已报价" }),
  );
  assert.equal(
    (await request(admin, `/customers/${ca.id}`, "PUT", stale)).status,
    409,
  );
  assert.equal((await ok(a, `/customers/${ca.id}`)).customer.notes, "最新版本");
  await ok(admin, `/customers/${ca.id}/delete`, "POST", {
    version: ca.version,
  });
  assert.equal((await request(a, `/customers/${ca.id}`)).status, 404);
  const trash = (await ok(admin, "/customers?deleted=true")).items[0];
  await ok(admin, `/customers/${ca.id}/restore`, "POST", {
    version: trash.version,
  });
  assert.equal((await ok(a, `/customers/${ca.id}`)).records.total, 3);
  pass("多人编辑冲突不覆盖；软删除可恢复且保留全部跟进历史");
  const badCsrf = await fetch(origin + "/api/customers", {
    method: "POST",
    headers: {
      Cookie: a.cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ company: "bad" }),
  });
  assert.equal(badCsrf.status, 403);
  const crossOrigin = await fetch(origin + "/api/auth/login", {
    method: "POST",
    headers: {
      Origin: "https://untrusted.invalid",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: "a@test.invalid", password }),
  });
  assert.equal(crossOrigin.status, 403);
  const team = await ok(admin, "/team"),
    employee = team.find((u: User) => u.id === aId);
  await ok(admin, `/team/${aId}`, "PUT", {
    name: employee.name,
    email: employee.email,
    role: employee.role,
    active: false,
    version: employee.version,
  });
  assert.equal((await request(a, "/customers")).status, 401);
  let disabled = (await ok(admin, "/team")).find((u: User) => u.id === aId);
  await ok(admin, `/team/${aId}`, "PUT", {
    name: disabled.name,
    email: disabled.email,
    role: disabled.role,
    active: true,
    version: disabled.version,
    password,
  });
  a = await login("a@test.invalid");
  await pool.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [(await import("../server/domain.ts")).hashToken(a.cookie.split("=")[1])],
  );
  assert.equal((await request(a, "/customers")).status, 401);
  a = await login("a@test.invalid");
  pass("CSRF、来源校验、密码重置、停用即时撤销和会话过期");
  const legacy = {
    customers: [
      {
        id: "legacy-test-1",
        company: "Legacy Import Building",
        contact: "Legacy Contact",
        country: "德国",
        grade: "C",
        owner: "旧销售",
      },
      { id: "legacy-dup", company: cb.company, owner: "旧销售" },
    ],
    ownerMap: { 旧销售: aId },
    backedUp: true,
  };
  const preview = await ok(admin, "/import/preview", "POST", legacy);
  assert.equal(preview.rows[1].duplicates.length, 1);
  const imported = await ok(admin, `/import/${preview.id}/commit`, "POST", {
    include: [0],
    confirmed: true,
  });
  assert.equal(imported.count, 1);
  assert.equal(
    (
      await request(admin, `/import/${preview.id}/commit`, "POST", {
        include: [0],
        confirmed: true,
      })
    ).status,
    409,
  );
  const preview2 = await ok(admin, "/import/preview", "POST", legacy);
  assert.equal(preview2.rows[0].alreadyImported, true);
  const filePreview = await ok(admin, "/import/preview", "POST", {
    ...legacy,
    customers: [
      ...legacy.customers,
      { ...legacy.customers[0], id: "legacy-file-duplicate" },
    ],
  });
  assert.ok(
    filePreview.rows[2].duplicates.some((d: { id: string }) => d.id === ""),
  );
  assert.equal((await ok(a, "/customers?tag=VIP")).total, 1);
  assert.equal((await ok(admin, "/customers?limit=1&page=2")).items.length, 1);
  pass("旧数据预检、负责人映射、重复客户提示、重复导入保护与筛选分页");
  // 关闭服务、连接池和 PostgreSQL 后重启同一持久数据目录。
  const before = (await ok(admin, "/customers")).total;
  await closeServer();
  await pool.end();
  await pg.stop();
  started = false;
  await pg.start();
  started = true;
  pool = database(
    `postgresql://postgres:${dbPassword}@127.0.0.1:${port}/crm_test`,
  );
  await startServer();
  assert.equal((await ok(admin, "/customers")).total, before);
  assert.equal((await ok(a, `/customers/${ca.id}`)).records.total, 3);
  const otherBrowser = await login("a@test.invalid");
  assert.equal(
    (await ok(otherBrowser, "/customers")).total,
    (await ok(a, "/customers")).total,
  );
  pass("退出重登、独立会话、应用和数据库实际重启后数据仍保留");
  const archive = await backup(pool),
    restorePool = database(
      `postgresql://postgres:${dbPassword}@127.0.0.1:${port}/crm_restore`,
    );
  try {
    await migrate(restorePool);
    const counts = await restore(restorePool, archive);
    assert.equal(counts.customers, before);
    assert.equal(
      (
        await restorePool.query(
          "SELECT count(*)::int AS n FROM follow_up_records",
        )
      ).rows[0].n,
      4,
    );
    assert.equal(
      (await restorePool.query("SELECT count(*)::int AS n FROM sessions"))
        .rows[0].n,
      0,
    );
    assert.equal(
      (await restorePool.query("SELECT count(*)::int AS n FROM users")).rows[0]
        .n,
      3,
    );
    await assert.rejects(() => restore(restorePool, archive), /不是空库/);
    const corrupt = structuredClone(archive);
    corrupt.payload.tables.customers = [];
    await assert.rejects(() => restore(restorePool, corrupt), /校验失败/);
  } finally {
    await restorePool.end();
  }
  pass("完整数据库备份校验、独立空库实际恢复、历史及账号核对、覆盖保护");
  const cliBackup = path.join(root, "backup.json"),
    sourceUrl = `postgresql://postgres:${dbPassword}@127.0.0.1:${port}/crm_test`;
  const exec = promisify(execFile);
  await exec(
    process.execPath,
    ["--import", "tsx", "scripts/backup.ts", "backup", cliBackup],
    { windowsHide: true, env: { ...process.env, DATABASE_URL: sourceUrl } },
  );
  await pg.createDatabase("crm_restore_cli");
  const cliUrl = `postgresql://postgres:${dbPassword}@127.0.0.1:${port}/crm_restore_cli`,
    cliPool = database(cliUrl);
  try {
    await migrate(cliPool);
    await exec(
      process.execPath,
      ["--import", "tsx", "scripts/backup.ts", "restore", cliBackup],
      {
        windowsHide: true,
        env: {
          ...process.env,
          DATABASE_URL: sourceUrl,
          RESTORE_DATABASE_URL: cliUrl,
          CONFIRM_RESTORE: "EMPTY_DATABASE_ONLY",
        },
      },
    );
    assert.equal(
      (await cliPool.query("SELECT count(*)::int AS n FROM customers")).rows[0]
        .n,
      before,
    );
    assert.equal(
      (await cliPool.query("SELECT count(*)::int AS n FROM follow_up_records"))
        .rows[0].n,
      4,
    );
  } finally {
    await cliPool.end();
  }
  pass("备份和恢复 CLI 命令实际执行，独立目标库数量与历史一致");
  // Browser plugin not available in this session; use installed Chromium/Edge via Playwright.
  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : undefined,
    headless: true,
  });
  const desktop = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await desktop.newPage(),
    pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const consoleErrors: string[] = [];
  const checkConsole = (p: Page) =>
    p.on("console", (message) => {
      if (
        ["error", "warning"].includes(message.type()) &&
        !/status of (401|404)/.test(message.text())
      )
        consoleErrors.push(message.text());
    });
  checkConsole(page);
  await browserLogin(page, "admin@test.invalid");
  assert.match(await page.title(), /奥汀堡CRM/);
  await expect(
    page.getByRole("heading", { name: "今天优先跟进", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Alpha Test Building", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(artifacts, "desktop-dashboard.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "员工管理", exact: true }).click();
  await page.getByRole("button", { name: "＋ 新增员工" }).click();
  const employeeDialog = page.getByRole("dialog");
  await employeeDialog
    .getByLabel("姓名 *", { exact: true })
    .fill("界面验收销售");
  await employeeDialog
    .getByLabel("邮箱 *", { exact: true })
    .fill("ui@test.invalid");
  await employeeDialog.getByLabel("初始密码 *", { exact: true }).fill(password);
  await employeeDialog.getByRole("button", { name: "保存员工" }).click();
  await expect(page.getByRole("cell", { name: /界面验收销售/ })).toBeVisible();
  await page.getByRole("link", { name: "客户管理", exact: true }).click();
  await page.getByLabel("搜索公司、联系人、联系方式").fill("Alpha");
  await expect(
    page.getByRole("link", { name: "Alpha Test Building", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Alpha Test Building", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "跟进时间线" })).toBeVisible();
  await expect(page.getByText("确认门窗尺寸", { exact: true })).toBeVisible();
  const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    }),
    mp = await mobile.newPage();
  mp.on("pageerror", (e) => pageErrors.push(e.message));
  checkConsole(mp);
  await browserLogin(mp, "a@test.invalid");
  await mp
    .getByRole("button", { name: "＋ 添加客户", exact: true })
    .first()
    .click();
  let dialog = mp.getByRole("dialog");
  await dialog
    .getByLabel("公司名称 *", { exact: true })
    .fill("Mobile Verified Building");
  await dialog.getByLabel("联系人", { exact: true }).fill("Mobile Contact");
  await dialog.getByRole("button", { name: "保存客户", exact: true }).click();
  await expect(dialog).toBeHidden();
  await mp.getByRole("link", { name: "搜索客户", exact: true }).click();
  await mp.getByLabel("搜索公司、联系人、联系方式").fill("Mobile Verified");
  await expect(
    mp.getByRole("link", { name: "Mobile Verified Building", exact: true }),
  ).toBeVisible();
  await mp.reload();
  await expect(
    mp.getByRole("link", { name: "Mobile Verified Building", exact: true }),
  ).toBeVisible();
  await mp
    .getByRole("link", { name: "Mobile Verified Building", exact: true })
    .click();
  await mp.getByRole("button", { name: "添加跟进", exact: true }).click();
  dialog = mp.getByRole("dialog");
  await dialog
    .getByLabel("本次跟进内容 *", { exact: true })
    .fill("手机完成需求沟通");
  await dialog.getByLabel("客户反馈", { exact: true }).fill("希望收到报价");
  await dialog.getByLabel("下一步计划", { exact: true }).fill("发送报价单");
  await dialog.getByRole("button", { name: "保存跟进", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(mp.getByText("手机完成需求沟通", { exact: true })).toBeVisible();
  assert.equal(
    await mp.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await mp.screenshot({
    path: path.join(artifacts, "mobile-customer.png"),
    fullPage: true,
  });
  await mp.goto(origin + `/customers/${cb.id}`);
  await expect(mp.getByRole("alert")).toContainText("客户不存在或无权访问");
  const forbidden = await mp.request.get(origin + `/api/customers/${cb.id}`);
  assert.equal(forbidden.status(), 404);
  await mp.getByRole("button", { name: "退出", exact: true }).click();
  await expect(
    mp.getByRole("button", { name: "登录", exact: true }),
  ).toBeVisible();
  await browserLogin(mp, "a@test.invalid");
  await mp.getByRole("link", { name: "搜索客户", exact: true }).click();
  await mp.getByLabel("搜索公司、联系人、联系方式").fill("Mobile Verified");
  await expect(
    mp.getByRole("link", { name: "Mobile Verified Building", exact: true }),
  ).toBeVisible();
  const separate = await browser.newContext(),
    sp = await separate.newPage();
  await browserLogin(sp, "b@test.invalid");
  await sp.getByRole("link", { name: "搜索客户", exact: true }).click();
  await sp.getByLabel("搜索公司、联系人、联系方式").fill("Mobile Verified");
  await expect(
    sp.getByText("暂无客户。添加客户后即可开始持续跟进。"),
  ).toBeVisible();
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  pass(
    "桌面及390px手机：登录、新增员工、客户搜索新增、刷新重登、跟进时间线、跨账号页面及接口拒绝、无JS异常/横向溢出",
  );
  await writeFile(
    path.join(artifacts, "results.json"),
    JSON.stringify(
      {
        runId,
        completed,
        artifacts,
        postgres: "18",
        browser: "Edge Chromium",
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    `ALL ${completed.length} CHECK GROUPS PASSED; evidence: ${artifacts}`,
  );
} catch (error) {
  console.error("INTEGRATION FAILED", error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await closeServer().catch(() => {});
  await pool.end().catch(() => {});
  if (started) await pg.stop();
  console.log("隔离测试服务已停止，保留隔离测试目录，不接触正式数据。");
}
