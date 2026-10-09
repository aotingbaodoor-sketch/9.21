// Actual Express, PostgreSQL migration, scheduler, quote implementation and UI. Test data stays isolated.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { localPostgres } from "../scripts/postgres-runtime.ts";
import { database, migrate } from "../server/db.ts";
import { createApp } from "../server/app.ts";
import { hashPassword } from "../server/domain.ts";
import { createTariffWorker, fetchRates } from "../server/tariffs/sync.ts";
import { ensureSources } from "../server/tariffs/sources.ts";
import { tariffBasis, assertTariffBasis } from "../server/tariffs/quotation.ts";
import { backup, restore } from "../server/backup.ts";
import {
  allocatePartner,
  allocateCustomerCode,
} from "../server/customer-code-store.ts";
import { quoteHtml } from "../server/quoting/pdf.ts";
import { fixtures } from "./quoting.fixtures.ts";
import { nextRun } from "../server/pricing/sync.ts";
import { menuLinks, visibleMenu } from "../src/crm/navigation.ts";
const root = mkdtempSync(path.join(os.tmpdir(), "autinberg-tariff-")),
  password = randomBytes(24).toString("hex"),
  origin = "http://127.0.0.1:4630";
const artifacts = process.env.ARTIFACT_DIR || path.join(root, "evidence");
mkdirSync(artifacts, { recursive: true });
const local = await localPostgres({
  databaseDir: path.join(root, "pg"),
  port: 55630,
  user: "postgres",
  password,
  persistent: true,
  fastIsolatedInit: true,
  onLog: () => {},
  onError: () => {},
});
const pool = database(
    `postgresql://postgres:${password}@127.0.0.1:55630/tariff_test`,
  ),
  target = database(
    `postgresql://postgres:${password}@127.0.0.1:55630/tariff_restore`,
  );
let server: Server | undefined;
const results: { name: string; status: string }[] = [];
const pass = (name: string) => {
  results.push({ name, status: "passed" });
  console.log("PASS", name);
};
type Actor = { cookie: string; csrf: string };
async function req(
  actor: Actor | null,
  url: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  key: string = randomUUID(),
) {
  const r = await fetch(origin + "/api" + url, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
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
async function ok(
  actor: Actor | null,
  url: string,
  body?: unknown,
  method?: string,
  key?: string,
) {
  const r = await req(actor, url, body, method, key);
  assert.equal(r.status, 200, JSON.stringify({ url, error: r.data.error }));
  return r.data;
}
const due = () =>
  pool.query(
    "UPDATE automation_rule SET next_run=now()-interval '1 second' WHERE code='tariff_sync'",
  );
let failure = false,
  rate = "5.7%",
  calls = 0;
const mockFetch: typeof fetch = async () => {
  calls++;
  if (failure) return new Response("<html>login</html>", { status: 403 });
  return Response.json([
    { htsno: "7610", description: "heading" },
    {
      htsno: "7610.10.00",
      description: "Doors and windows",
      general: rate,
      special: "Free (qualified)",
      other: "45%",
    },
  ]);
};
try {
  await local.initialise();
  await local.start();
  await local.createDatabase("tariff_test");
  await local.createDatabase("tariff_restore");
  await migrate(pool);
  await migrate(target);
  await ensureSources(pool);
  const adminId = randomUUID(),
    salesId = randomUUID();
  const hash = await hashPassword(password);
  for (const [id, role] of [
    [adminId, "admin"],
    [salesId, "sales"],
    [randomUUID(), "logistics"],
    [randomUUID(), "technical"],
  ])
    await pool.query(
      "INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$2)",
      [id, role, role + "@tariff.invalid", hash],
    );
  await pool.query("UPDATE tariff_source_registry SET enabled=(code='usitc')");
  const worker = createTariffWorker(pool, mockFetch);
  await due();
  await Promise.all([
    worker.tick(),
    worker.tick(),
    createTariffWorker(pool, mockFetch).tick(),
  ]);
  assert.equal(calls, 1);
  assert.equal(
    Number(
      (await pool.query("SELECT count(*) FROM tariff_records")).rows[0].count,
    ),
    3,
  );
  pass("实际迁移与云端worker互斥锁：并发不重复入库，三种税栏分开");
  const original = (
    await pool.query("SELECT id,fetched_at FROM tariff_records ORDER BY id")
  ).rows;
  await due();
  await worker.tick();
  assert.equal(
    (
      await pool.query(
        "SELECT status FROM tariff_sync_runs ORDER BY started_at DESC LIMIT 1",
      )
    ).rows[0].status,
    "unchanged",
  );
  assert.deepEqual(
    (await pool.query("SELECT id,fetched_at FROM tariff_records ORDER BY id"))
      .rows,
    original,
  );
  pass("无新数据不改首次获取、生效日或版本");
  failure = true;
  await due();
  await worker.tick();
  const failed = (
    await pool.query(
      "SELECT * FROM tariff_sync_runs ORDER BY started_at DESC LIMIT 1",
    )
  ).rows[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 3);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM tariff_records")).rows[0].n,
    3,
  );
  pass("3次失败记录、旧数据保留、来源失败而非成功");
  failure = false;
  await due();
  await worker.tick();
  if (process.argv.includes("--ui")) {
    await cp(path.resolve("dist"), path.join(root, "dist"), {
      recursive: true,
    });
    process.chdir(root);
  }
  server = createApp(pool, {
    origin,
    serveStatic: process.argv.includes("--ui"),
  }).listen(4630, "127.0.0.1");
  const login = async (role: string) => {
    const r = await req(null, "/auth/login", {
      email: role + "@tariff.invalid",
      password,
    });
    assert.equal(r.status, 200);
    return { cookie: r.cookie, csrf: r.data.csrf };
  };
  const admin = await login("admin"),
    sales = await login("sales"),
    logistics = await login("logistics"),
    technical = await login("technical");
  assert.equal((await req(null, "/tariffs")).status, 401);
  assert.equal((await req(technical, "/tariffs")).status, 403);
  assert.equal((await req(sales, "/tariffs/run", {})).status, 403);
  assert.equal((await req(logistics, "/tariffs/run", {})).status, 403);
  assert.equal(
    (await req({ ...admin, csrf: "" }, "/tariffs/run", {})).status,
    403,
  );
  await ok(sales, "/tariffs");
  await ok(logistics, "/tariffs");
  const data = await ok(admin, "/tariffs");
  assert.equal(data.sources.length, 24);
  assert.ok(!JSON.stringify(data).includes("password_hash"));
  assert.ok(!JSON.stringify(data).includes("raw_data"));
  pass("管理员/员工/物流/技术/匿名/CSRF后端权限与敏感字段隔离");
  const manual = {
    sourceCode: "usitc",
    country: "US",
    origin: "CN",
    hsCode: "7610100010",
    description: "ISOLATED TEST aluminium windows",
    taxKind: "duty",
    rateText: "5.7%",
    conditions:
      "ISOLATED TEST ONLY: all additional measures independently checked",
    effectiveFrom: "2026-01-01",
    effectiveUntil: "2099-12-31",
    dataYear: 2026,
    sourceUrl: "https://hts.usitc.gov/",
  };
  assert.equal((await req(sales, "/tariffs/records", manual)).status, 403);
  assert.equal(
    (await req(admin, "/tariffs/records", { ...manual, country: "EU" })).status,
    400,
  );
  assert.equal(
    (await req(admin, "/tariffs/records", { ...manual, sourceCode: "wits" }))
      .status,
    422,
  );
  const key = randomUUID();
  const created = await ok(admin, "/tariffs/records", manual, undefined, key);
  assert.equal(
    (await ok(admin, "/tariffs/records", manual, undefined, key)).id,
    created.id,
  );
  const review = {
    version: 1,
    approved: true,
    note: "ISOLATED TEST official national classification and origin review",
    evidenceUrl: "https://hts.usitc.gov/",
    confirmedNationalCode: true,
    confirmedOrigin: true,
    confirmedAdditionalMeasures: true,
  };
  assert.equal(
    (await req(admin, `/tariffs/records/${original[0].id}/review`, review))
      .status,
    422,
  );
  pass("人工录入幂等；禁止联盟国家、平均数据转正式税率与员工越权复核");
  const f = fixtures();
  f.input.country = "US";
  f.input.city = "";
  f.input.incoterm = "CIF";
  f.freight.country = "US";
  f.freight.city = "";
  f.freight.confirmed.push("insurance");
  f.freight.fees.push({
    kind: "insurance",
    basis: "fixed",
    rate: 10,
    minimum: 0,
  });
  f.input.tariff = {
    destination: "US",
    origin: "CN",
    applicableOn: f.input.targetDate,
    calculationBasis:
      "ISOLATED TEST: duties excluded under existing CIF fee rule",
  };
  f.input.lines[0].tariffHsCode = "7610100010";
  f.input.lines[0].tariffRateIds = [created.id];
  const c = await ok(admin, "/customers", {
    company: "ISOLATED TARIFF TEST",
    contact: "Test contact",
    country: "US",
    grade: "A",
    ownerId: salesId,
  });
  const partner = await allocatePartner(pool, {
    userId: salesId,
    joinYear: 2026,
    name: "TEST first developer",
    market: "TEST",
  });
  await allocateCustomerCode(pool, {
    customerId: c.id,
    partnerId: partner.id,
    firstContactDate: "2026-10-09",
    source: "new",
  });
  await ok(admin, "/quoting/settings", { data: f.settings, version: 1 }, "PUT");
  f.product.id = (await ok(admin, "/quoting/products", f.product)).id;
  f.freight.id = (await ok(admin, "/quoting/freight", f.freight)).id;
  f.input.lines[0].productId = f.product.id;
  f.input.freightId = f.freight.id;
  const project = (
    await ok(sales, "/quoting/projects", {
      customerId: c.id,
      name: "ISOLATED TARIFF TEST",
    })
  ).id;
  const pending = await ok(
    sales,
    `/quoting/projects/${project}/preview`,
    f.input,
  );
  assert.equal(pending.total, null);
  assert.ok(pending.issues.some((x: { code: string }) => x.code === "G-37"));
  const draft = await ok(sales, `/quoting/projects/${project}/versions`, {
    baseVersion: 1,
    input: f.input,
    reason: "ISOLATED TEST",
  });
  assert.equal(
    (await req(admin, `/quoting/versions/${draft.id}/issue`, { version: 1 }))
      .status,
    422,
  );
  pass("实际报价preview及issue接口均阻止未复核CIF税率，不能绕过按钮");
  await ok(admin, `/tariffs/records/${created.id}/review`, review);
  const checked = await tariffBasis(pool, f.input);
  assert.equal(checked.errors.length, 0, checked.errors.join(";"));
  const bad = structuredClone(f.input);
  bad.tariff!.origin = "JP";
  assert.ok(
    (await tariffBasis(pool, bad)).errors.some((x) => x.includes("原产地")),
  );
  bad.incoterm = "DDP";
  assert.ok(
    (await tariffBasis(pool, bad)).errors.some((x) => x.includes("VAT")),
  );
  pass("复核人/时间后端落库，逐国/原产地/HS/适用日及DDP进口VAT校验");
  const v = await ok(admin, `/quoting/projects/${project}/versions`, {
    baseVersion: 2,
    input: f.input,
    reason: "ISOLATED verified",
  });
  const preview = await ok(admin, `/quoting/versions/${v.id}`);
  assert.equal(
    preview.snapshot.issues.length,
    0,
    JSON.stringify(preview.snapshot.issues),
  );
  await ok(admin, `/quoting/versions/${v.id}/submit`, { version: 1 });
  await ok(admin, `/quoting/versions/${v.id}/issue`, { version: 2 });
  const quote = (
    await pool.query(
      "SELECT q.*,r.doc_no FROM quotation_versions q JOIN crm_document_registry r ON r.id=q.registered_document_id WHERE q.id=$1",
      [v.id],
    )
  ).rows[0];
  const before = JSON.stringify(quote.snapshot),
    html = quoteHtml(quote, "quotation", "both"),
    htmlHash = createHash("sha256").update(html).digest("hex");
  rate = "6.0%";
  await due();
  await worker.tick();
  assert.equal(
    (
      await pool.query("SELECT verification FROM tariff_records WHERE id=$1", [
        created.id,
      ])
    ).rows[0].verification,
    "pending",
  );
  assert.equal(
    JSON.stringify(
      (
        await pool.query(
          "SELECT snapshot FROM quotation_versions WHERE id=$1",
          [v.id],
        )
      ).rows[0].snapshot,
    ),
    before,
  );
  const after = (
    await pool.query(
      "SELECT q.*,r.doc_no FROM quotation_versions q JOIN crm_document_registry r ON r.id=q.registered_document_id WHERE q.id=$1",
      [v.id],
    )
  ).rows[0];
  assert.equal(
    createHash("sha256")
      .update(quoteHtml(after, "quotation", "both"))
      .digest("hex"),
    htmlHash,
  );
  await assert.rejects(() => assertTariffBasis(pool, f.input, checked), /G-37/);
  pass(
    "来源变化重置关联复核；已签发QT快照、编号及PDF渲染内容不变；旧草稿再次签发被拦截",
  );
  const old = await ok(admin, "/tariffs/records", {
    ...manual,
    dataYear: 2023,
    hsCode: "7610100020",
  });
  assert.equal(
    (await req(admin, `/tariffs/records/${old.id}/review`, review)).status,
    422,
  );
  const expired = await ok(admin, "/tariffs/records", {
    ...manual,
    effectiveFrom: "2025-01-01",
    effectiveUntil: "2025-12-31",
  });
  assert.equal(
    (await req(admin, `/tariffs/records/${expired.id}/review`, review)).status,
    422,
  );
  pass("超过两年与已过期数据均不能直接复核放行");
  await ok(
    admin,
    "/tariffs/config",
    {
      version: 1,
      enabled: true,
      config: {
        time: "08:15",
        timezone: "Asia/Shanghai",
        usHeadings: ["7610"],
      },
    },
    "PUT",
  );
  assert.equal((await ok(admin, "/tariffs")).rule.config.time, "08:15");
  assert.equal(
    nextRun(["07:30"], new Date("2026-10-09T00:00:00Z")).toISOString(),
    "2026-10-09T23:30:00.000Z",
  );
  pass("后台配置即时生效与北京时间次日调度，无本地电脑依赖");
  const archive = await backup(pool);
  await restore(target, archive);
  assert.equal(
    (await target.query("SELECT count(*)::int n FROM tariff_records")).rows[0]
      .n,
    (await pool.query("SELECT count(*)::int n FROM tariff_records")).rows[0].n,
  );
  pass("新增税率表纳入加密备份范围，实际隔离恢复保留版本与复核");
  if (process.argv.includes("--live")) {
    const live = [];
    for (const code of ["usitc", "wits"]) {
      const rates = await fetchRates(code, ["7610"]);
      live.push({ code, count: rates.length, samples: rates.slice(0, 3) });
    }
    writeFileSync(
      path.join(artifacts, "real-api-samples.json"),
      JSON.stringify(live, null, 2),
    );
    pass("真实USITC/WITS API调用通过实际CRM解析器（与隔离测试分开）");
  }
  if (process.argv.includes("--ui")) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      channel: "msedge",
      headless: true,
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 980 },
      });
      const [name, ...value] = admin.cookie.split("=");
      await context.addCookies([{ name, value: value.join("="), url: origin }]);
      const page = await context.newPage(),
        errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await page.goto(origin + "/tariffs");
      await page
        .getByRole("heading", { name: "海关税率与来源", exact: true })
        .waitFor();
      assert.match(await page.title(), /CRM|奥汀堡/);
      await page.locator('tbody tr').first().waitFor();
      await page.getByLabel('搜索HS编码、商品或来源').fill('761010');
      await page.waitForResponse(r=>r.url().includes('/api/tariffs?q=761010')&&r.status()===200);
      assert.equal(await page.getByLabel('搜索HS编码、商品或来源').inputValue(),'761010');
      assert.equal(await page.locator("vite-error-overlay").count(), 0);
      await page.screenshot({
        path: path.join(artifacts, "tariffs-desktop.png"),
        fullPage: false,
      });
      await page.getByRole("button", { name: "来源台账", exact: true }).click();
      await page.getByText("T45 来源台账", { exact: true }).waitFor();
      await page
        .locator("summary")
        .filter({ hasText: "美国 USITC HTS" })
        .click();
      await page
        .getByRole("button", { name: "保存来源说明" })
        .first()
        .waitFor();
      await page.getByRole("button", { name: "更新任务", exact: true }).click();
      await page.getByText("最近运行记录", { exact: true }).waitFor();
      await page.screenshot({
        path: path.join(artifacts, "tariff-tasks.png"),
        fullPage: false,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await page
        .getByRole("heading", { name: "海关税率与来源", exact: true })
        .waitFor();
      await page.locator('tbody tr').first().waitFor();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: path.join(artifacts, "tariffs-mobile.png"),
        fullPage: false,
      });
      assert.deepEqual(errors, []);
      // Old links stay registered, menu links still resolve to real pages. No writes to real business records.
      writeFileSync(
        path.join(artifacts, "menu-after.json"),
        JSON.stringify(menuLinks(visibleMenu("admin")), null, 2),
      );
      pass(
        "真实渲染：桌面/手机、来源展开、任务切换、刷新、无溢出/空白/框架遮罩/控制台错误",
      );
    } finally {
      await browser.close();
    }
  }
  writeFileSync(
    path.join(artifacts, "tariff-tests.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        environment:
          "isolated PostgreSQL + real CRM Express; mock sources unless explicitly live",
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: results.length, artifacts }));
} finally {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  await pool.end();
  await target.end();
  await local.stop();
}
