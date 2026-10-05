// ISOLATED DATABASE ONLY: tests the actual Express routes, database migrations and numbering service.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cp } from "node:fs/promises";
import type { Server } from "node:http";
import { localPostgres } from "../scripts/postgres-runtime.ts";
import { database, migrate } from "../server/db.ts";
import { hashPassword } from "../server/domain.ts";
import { createApp } from "../server/app.ts";
import { registerDocument } from "../server/document-registry.ts";
import { backup, restore } from "../server/backup.ts";
const root = mkdtempSync(path.join(os.tmpdir(), "autinberg-chain-")),
  password = randomBytes(32).toString("base64url");
const local = await localPostgres({
  databaseDir: path.join(root, "pg"),
  port: 55620,
  user: "postgres",
  password,
  persistent: true,
  fastIsolatedInit: true,
  onLog: () => {},
  onError: () => {},
});
const pool = database(
  `postgresql://postgres:${password}@127.0.0.1:55620/chain_test`,
);
const origin = "http://127.0.0.1:4620";
let server: Server | undefined,
  started = false;
type Actor = { cookie: string; csrf: string };
const results: { name: string; status: string }[] = [];
function passed(name: string) {
  results.push({ name, status: "passed" });
  console.log("PASS", name);
}
async function request(
  actor: Actor | null,
  url: string,
  body?: unknown,
  key: string = randomUUID(),
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(origin + "/api" + url, {
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
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
  };
}
async function ok(
  actor: Actor | null,
  url: string,
  body?: unknown,
  key?: string,
  method?: string,
) {
  const r = await request(actor, url, body, key, method);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
try {
  console.log("Starting isolated database, no production connection");
  await local.initialise();
  await local.start();
  started = true;
  await local.createDatabase("chain_test");
  await migrate(pool);
  await migrate(pool);
  passed("020 additive migrations apply twice without duplicate changes");
  const adminId = randomUUID(),
    salesId = randomUUID(),
    otherId = randomUUID(),
    factoryUser = randomUUID(),
    factoryId = randomUUID(),
    hash = await hashPassword(password);
  for (const [id, role, email] of [
    [adminId, "admin", "admin"],
    [salesId, "sales", "sales"],
    [otherId, "sales", "other"],
    [factoryUser, "factory", "factory"],
  ]) {
    await pool.query(
      "INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)",
      [id, email, email + "@chain.invalid", hash, role],
    );
  }
  if (process.argv.includes("--ui")) {
    // Express sendFile refuses hidden .codex ancestors; serve generated assets from the isolated temp root.
    const source = path.resolve("dist"),
      web = path.join(root, "web");
    mkdirSync(web, { recursive: true });
    await cp(source, path.join(web, "dist"), { recursive: true });
    process.chdir(web);
  }
  server = createApp(pool, { origin, serveStatic: true }).listen(
    4620,
    "127.0.0.1",
  );
  await new Promise<void>((r) => server!.once("listening", r));
  const login = async (email: string) => {
    const r = await request(null, "/auth/login", {
      email: email + "@chain.invalid",
      password,
    });
    assert.equal(r.status, 200);
    return { cookie: r.cookie, csrf: r.data.csrf };
  };
  const admin = await login("admin"),
    sales = await login("sales"),
    other = await login("other"),
    factory = await login("factory");
  const classes = await ok(admin, "/settings/document-classes");
  assert.equal(classes.length, 24);
  assert.equal(classes.filter((c: any) => c.family === "A").length, 9);
  assert.equal(classes.find((c: any) => c.code === "TC").family, "A");
  assert.equal(
    (await request(sales, "/settings/document-classes")).status,
    403,
  );
  passed("24 classes from database, TC A class, configuration admin-only");
  await ok(admin, "/customer-identities/sources/initialize", {});
  const sources = await ok(admin, "/customer-identities/sources");
  const customer = await ok(admin, "/customers", {
    company: "ISOLATED Private Buyer",
    ownerId: salesId,
    email: "buyer@private.invalid",
  });
  // The existing creation API retains its own assignment contract; isolate ownership in fixture setup.
  await pool.query("UPDATE customers SET owner_id=$2 WHERE id=$1", [
    customer.id,
    salesId,
  ]);
  const identity = await ok(admin, `/customers/${customer.id}/identity`, {
    partnerId: sources[0].id,
    firstContactDate: "2026-10-04",
    confirmHistoricalInfoOnly: false,
  });
  assert.equal(identity.code.length, 13);
  const ledger = await ok(admin, "/master-data/numbering");
  assert.equal(ledger.customers[0].first_dev_partner_id, sources[0].id);
  const projectId = randomUUID(),
    quoteId = randomUUID(),
    quoteOrder = randomUUID(),
    orderId = randomUUID(),
    itemId = randomUUID();
  await pool.query(
    "INSERT INTO quotation_projects(id,customer_id,name,created_by) VALUES($1,$2,'ISOLATED chain',$3)",
    [projectId, customer.id, adminId],
  );
  await pool.query(
    "INSERT INTO quotation_versions(id,project_id,number,input,snapshot,customer_snapshot,reason,status,issued_at,created_by) VALUES($1,$2,1,$3,$4,$5,$6,$7,now(),$8)",
    [
      quoteId,
      projectId,
      "{}",
      '{"issues":[],"total":100}',
      "{}",
      "ISOLATED",
      "confirmed",
      adminId,
    ],
  );
  await pool.query(
    "INSERT INTO quotation_orders(id,project_id,quote_id,snapshot,created_by) VALUES($1,$2,$3,'{}',$4)",
    [quoteOrder, projectId, quoteId, adminId],
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO sales_orders(id,quotation_order_id,order_number,created_by) VALUES($1,$2,'BLOCKED',$3)",
      [randomUUID(), quoteOrder, adminId],
    ),
  );
  // A historical SO allows us to verify WO rejection before financial evidence exists.
  await pool.query(
    "INSERT INTO sales_orders(id,quotation_order_id,order_number,created_by,deposit_gate_required) VALUES($1,$2,'LEGACY-TEST-SO',$3,false)",
    [orderId, quoteOrder, adminId],
  );
  await pool.query(
    "INSERT INTO sales_order_items(id,sales_order_id,line_key,configuration_snapshot,quantity) VALUES($1,$2,'Door-01','{}',2)",
    [itemId, orderId],
  );
  await pool.query(
    "INSERT INTO factories(id,name) VALUES($1,'ISOLATED factory')",
    [factoryId],
  );
  await pool.query(
    "INSERT INTO factory_users(factory_id,user_id,status) VALUES($1,$2,'approved')",
    [factoryId, factoryUser],
  );
  const file = await ok(admin, `/quoting/projects/${projectId}/files`, {
    name: "ISOLATED confirmation.pdf",
    mime: "application/pdf",
    data: Buffer.from("%PDF-1.4\nISOLATED proof").toString("base64"),
    kind: "confirmation",
  });
  const woInput = {
    salesOrderId: orderId,
    expectedDelivery: "2026-11-01",
    confirmationFileId: file.id,
    orderType: "bulk",
    tradeTerm: "FOB",
  };
  assert.equal((await request(admin, "/supply/chain", woInput)).status, 409);
  const poInput = { factoryId, itemIds: [itemId], promisedDate: "2026-10-30" };
  assert.equal(
    (await request(admin, `/supply/orders/${orderId}/purchase-orders`, poInput))
      .status,
    409,
  );
  passed("SO database gate and WO/PO HTTP gates reject missing deposit");
  const ar = await registerDocument(
    pool,
    {
      classCode: "AR",
      customerIds: [customer.id],
      date: "2026-10-05",
      businessKind: "isolated_deposit",
      businessId: quoteOrder,
      requestKey: randomUUID(),
      actorId: adminId,
    },
    async (db, d) => {
      await db.query(
        "INSERT INTO quotation_deposits(id,quotation_order_id,document_id,data,created_by) VALUES($1,$2,$3,$4,$5)",
        [
          randomUUID(),
          quoteOrder,
          d.id,
          JSON.stringify({
            amount: 30,
            currency: "USD",
            receivedAt: new Date().toISOString(),
            reference: "ISOLATED",
          }),
          adminId,
        ],
      );
    },
  );
  assert.match(ar.doc_no, /^AR\d{10}$/);
  await ok(admin, `/supply/orders/${orderId}/evidence`, {
    kind: "deposit",
    amount: 30,
    currency: "USD",
    receivedAt: new Date().toISOString(),
    reference: "ISOLATED deposit",
  });
  assert.equal(
    (await request(admin, `/supply/orders/${orderId}/purchase-orders`, poInput))
      .status,
    409,
  );
  const wk = randomUUID(),
    work = await ok(admin, "/supply/chain", woInput, wk);
  assert.deepEqual(await ok(admin, "/supply/chain", woInput, wk), work);
  assert.equal(
    (
      await request(
        admin,
        "/supply/chain",
        { ...woInput, expectedDelivery: "2026-12-01" },
        wk,
      )
    ).status,
    409,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM crm_work_orders")).rows[0].n,
    1,
  );
  assert.equal(
    (await ok(admin, `/supply/chain/${work.id}`)).progress.length,
    22,
  );
  const notificationCounts = (
    await pool.query(
      "SELECT visibility,count(*)::int n FROM crm_fulfillment_stage GROUP BY visibility ORDER BY visibility",
    )
  ).rows;
  assert.deepEqual(notificationCounts, [
    { visibility: "none", n: 14 },
    { visibility: "notify", n: 3 },
    { visibility: "required", n: 5 },
  ]);
  await assert.rejects(
    pool.query(
      "UPDATE crm_work_orders SET expected_delivery='2026-12-01' WHERE id=$1",
      [work.id],
    ),
  );
  assert.equal((await request(sales, "/supply/chain", woInput)).status, 403);
  assert.equal((await request(other, `/supply/chain/${work.id}`)).status, 404);
  assert.equal(
    (await ok(sales, `/supply/chain/${work.id}`)).order.customer_id,
    customer.id,
  );
  passed(
    "WO idempotency, 22 actual persisted states, immutable dates, employee isolation",
  );
  const pk = randomUUID(),
    po = await ok(
      admin,
      `/supply/orders/${orderId}/purchase-orders`,
      poInput,
      pk,
    );
  assert.deepEqual(
    await ok(admin, `/supply/orders/${orderId}/purchase-orders`, poInput, pk),
    po,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT work_order_id FROM purchase_orders WHERE id=$1",
        [po.id],
      )
    ).rows[0].work_order_id,
    work.id,
  );
  const moInput = {
    purchaseOrderId: po.id,
    technical: {
      profile: "6063-T5",
      glass: "5+12A+5",
      hardware: "Approved H1",
      finish: "RAL 9016",
      sampleReference: "Approved sample S1",
      packing: "Timber crate",
      requiredDate: "2026-10-30",
    },
  };
  assert.equal(
    (await request(admin, `/supply/chain/${work.id}/manufacturing`, moInput))
      .status,
    409,
  );
  const measurement = await ok(admin, `/supply/orders/${orderId}/evidence`, {
    kind: "measurement",
    fileId: file.id,
    note: "ISOLATED measurements",
  });
  await ok(admin, `/supply/orders/${orderId}/evidence`, {
    kind: "dimensions",
    measurementId: measurement.id,
    lines: [{ itemId, widthMm: 1000, heightMm: 2000 }],
    note: "ISOLATED final dimensions",
  });
  assert.equal(
    (
      await request(admin, `/supply/orders/${orderId}/evidence`, {
        kind: "instruction",
        note: "Must not bypass numbered MO",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(admin, `/supply/chain/${work.id}/manufacturing`, {
        ...moInput,
        technical: { ...moInput.technical, finish: "ISOLATED Private Buyer" },
      })
    ).status,
    422,
  );
  const mk = randomUUID(),
    mo = await ok(admin, `/supply/chain/${work.id}/manufacturing`, moInput, mk);
  assert.deepEqual(
    await ok(admin, `/supply/chain/${work.id}/manufacturing`, moInput, mk),
    mo,
  );
  assert.deepEqual(
    await ok(admin, `/supply/chain/${work.id}/manufacturing`, moInput),
    mo,
  );
  assert.equal(
    (
      await request(admin, `/supply/chain/${work.id}/manufacturing`, {
        ...moInput,
        technical: { ...moInput.technical, profile: "different" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(admin, `/supply/orders/${orderId}/evidence`, {
        kind: "measurement",
        fileId: file.id,
        note: "Cannot change after MO",
      })
    ).status,
    409,
  );
  const factoryView = await ok(factory, `/supply/manufacturing/${mo.id}`);
  assert.equal(factoryView.audience, "factory");
  assert.equal(factoryView.customerCode, identity.code);
  assert.equal(factoryView.technical.items[0].quantity, 2);
  for (const forbidden of [
    "ISOLATED Private Buyer",
    "buyer@private.invalid",
    "customer_id",
    "owner_id",
    "cost",
    "profit",
  ])
    assert.ok(!JSON.stringify(factoryView).includes(forbidden));
  assert.equal(
    (await request(other, `/supply/manufacturing/${mo.id}`)).status,
    404,
  );
  await assert.rejects(
    pool.query(
      "UPDATE crm_manufacturing_orders SET customer_code='changed' WHERE id=$1",
      [mo.id],
    ),
  );
  passed(
    "MO measurement/dimension gate, triple relationship, immutable factory projection, legacy instruction blocked",
  );
  assert.equal(
    (
      await request(admin, `/supply/orders/${orderId}/evidence`, {
        kind: "instruction",
        note: "Missing IQC",
      })
    ).status,
    409,
  );
  await ok(admin, `/supply/chain/${work.id}/advance`, {
    stage: "material_ready",
    fileId: file.id,
    inspectionResult: "passed",
    note: "ISOLATED IQC verified",
  });
  await ok(admin, `/supply/orders/${orderId}/evidence`, {
    kind: "instruction",
    note: "ISOLATED actual production start",
  });
  const detail = await ok(admin, `/supply/chain/${work.id}`);
  assert.equal(detail.order.current_stage, "in_production");
  assert.equal(detail.notices.length, 2);
  assert.ok(detail.notices.every((n: any) => n.status === "draft"));
  passed(
    "IQC evidence then numbered instruction starts production, customer notices remain drafts",
  );
  const logistics = {
    docType: "pod",
    fileId: file.id,
    sourceName: "ISOLATED test carrier",
    receivedOn: new Date().toISOString(),
    externalNo: "ISOLATED POD",
  };
  const lk = randomUUID(),
    ld = await ok(admin, `/supply/chain/${work.id}/logistics`, logistics, lk);
  assert.deepEqual(
    await ok(admin, `/supply/chain/${work.id}/logistics`, logistics, lk),
    ld,
  );
  await ok(admin, `/supply/chain/${work.id}/logistics/${ld.id}/check`, {
    result: "matched",
  });
  assert.equal(
    (await ok(admin, `/supply/chain/${work.id}`)).order.current_stage,
    "in_production",
  );
  assert.equal(
    (await request(other, `/customers/${customer.id}/document-chain`)).status,
    404,
  );
  const chain = await ok(sales, `/customers/${customer.id}/document-chain`);
  for (const type of ["AR", "WO", "PO", "MO"])
    assert.ok(chain.documents.some((d: any) => d.class_code === type));
  passed(
    "Logistics save/check/replay do not pretend POD completes order; explicit customer joins and isolation",
  );
  const input = {
    classCode: "TC",
    customerIds: [customer.id],
    date: "2026-10-05",
    businessKind: "isolated_TC",
    actorId: adminId,
  };
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, () =>
      registerDocument(
        pool,
        { ...input, businessId: randomUUID(), requestKey: randomUUID() },
        async () => {},
      ),
    ),
  );
  assert.equal(new Set(concurrent.map((d) => d.doc_no)).size, 20);
  assert.ok(
    concurrent.every((d) => d.doc_no.startsWith(identity.code + "-TC")),
  );
  const replay = {
    ...input,
    businessId: randomUUID(),
    requestKey: randomUUID(),
  };
  let created = 0;
  const repeated = await Promise.all(
    Array.from({ length: 20 }, () =>
      registerDocument(pool, replay, async () => {
        created++;
      }),
    ),
  );
  assert.equal(new Set(repeated.map((d) => d.doc_no)).size, 1);
  assert.equal(created, 1);
  passed(
    "20 parallel allocations unique; 20 repeated requests issue once using actual registry",
  );
  await ok(
    admin,
    "/settings/document-classes/TC",
    { enabled: false },
    undefined,
    "PUT",
  );
  await assert.rejects(
    registerDocument(
      pool,
      { ...input, businessId: randomUUID(), requestKey: randomUUID() },
      async () => {},
    ),
  );
  await ok(
    admin,
    "/settings/document-classes/TC",
    { enabled: true },
    undefined,
    "PUT",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM crm_document_registry WHERE class_code=$1",
        ["TC"],
      )
    ).rows[0].n,
    21,
  );
  passed("Class switches immediate, no restart; issued documents unchanged");
  await local.createDatabase("chain_restore");
  const restored = database(
    `postgresql://postgres:${password}@127.0.0.1:55620/chain_restore`,
  );
  try {
    await migrate(restored);
    const archive = await backup(pool);
    await restore(restored, archive);
    assert.equal(
      (await restored.query("SELECT count(*)::int n FROM crm_work_orders"))
        .rows[0].n,
      1,
    );
    assert.equal(
      (
        await restored.query(
          "SELECT count(*)::int n FROM crm_manufacturing_orders",
        )
      ).rows[0].n,
      1,
    );
    assert.deepEqual(
      (
        await restored.query(
          "SELECT doc_no FROM crm_document_registry ORDER BY doc_no",
        )
      ).rows,
      (
        await pool.query(
          "SELECT doc_no FROM crm_document_registry ORDER BY doc_no",
        )
      ).rows,
    );
    await assert.rejects(restore(restored, archive));
    passed(
      "Application backup restores new chain/numbering into an isolated empty database; refuses overwrite",
    );
  } finally {
    await restored.end();
  }
  if (process.argv.includes("--ui")) {
    const out =
      "C:/Users/HUAWEI/Documents/AUTINBERG-Deliveries/fulfillment-20261005/evidence";
    mkdirSync(out, { recursive: true });
    if (!process.argv.includes("--skip-exports")) {
      const ExcelJS = (await import("exceljs")).default;
      const xlsx = await fetch(
        origin + `/api/supply/manufacturing/${mo.id}/export/xlsx`,
        { headers: { Cookie: factory.cookie } },
      );
      assert.equal(xlsx.status, 200);
      const excelBytes = Buffer.from(await xlsx.arrayBuffer());
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(
        excelBytes as unknown as Parameters<typeof book.xlsx.load>[0],
      );
      const sheet = book.worksheets[0];
      assert.equal(sheet.getCell("C4").text, mo.docNo);
      assert.equal(sheet.getCell("C6").text, identity.code);
      assert.equal(sheet.getCell("E13").value, 2);
      const cells = book.worksheets
        .flatMap((s) => s.getSheetValues())
        .flat(5)
        .filter(Boolean)
        .join(" ");
      assert.ok(
        !/ISOLATED Private Buyer|buyer@private.invalid|客户名称|Customer Name|终端客户|end customer|客户成交价/.test(
          cells,
        ),
      );
      writeFileSync(path.join(out, "isolated-manufacturing.xlsx"), excelBytes);
      const pdf = await fetch(
        origin + `/api/supply/manufacturing/${mo.id}/export/pdf`,
        { headers: { Cookie: factory.cookie } },
      );
      assert.equal(pdf.status, 200);
      const pdfBytes = Buffer.from(await pdf.arrayBuffer());
      assert.equal(pdfBytes.subarray(0, 5).toString(), "%PDF-");
      writeFileSync(path.join(out, "isolated-manufacturing.pdf"), pdfBytes);
      assert.equal(
        (
          await fetch(
            origin + `/api/supply/manufacturing/${mo.id}/export/pdf`,
            { headers: { Cookie: other.cookie } },
          )
        ).status,
        404,
      );
      passed(
        "Real MO Excel/PDF exports use saved number and isolated factory projection; other employee denied",
      );
    }
    const { chromium, expect } = await import("@playwright/test");
    const browser = await chromium.launch({
      channel: "msedge",
      headless: true,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(origin);
      await page
        .getByLabel("邮箱", { exact: true })
        .fill("admin@chain.invalid");
      await page.getByLabel("密码", { exact: true }).fill(password);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "退出", exact: true }),
      ).toBeVisible({ timeout: 15000 });
      await page.goto(origin + "/supply/chain");
      await expect(
        page.getByRole("heading", { name: "订单履约链", exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: work.docNo, exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "22态履约进度" }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(out, "chain-desktop.png"),
        fullPage: true,
      });
      await page
        .getByRole("link", { name: mo.docNo + " 工厂版", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "生产指令单 / Manufacturing Order",
          exact: true,
        }),
      ).toBeVisible();
      assert.ok(
        !(await page.locator("body").innerText()).includes(
          "ISOLATED Private Buyer",
        ),
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(origin + "/settings/document-classes");
      await expect(
        page.getByRole("heading", { name: "9.1 单据类码" }),
      ).toBeVisible();
      await expect(
        page.getByRole("cell", { name: "TC", exact: true }),
      ).toBeVisible();
      await expect(page.locator("tbody tr")).toHaveCount(24);
      await page.screenshot({
        path: path.join(out, "classes-mobile.png"),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
        false,
      );
      assert.deepEqual(errors, []);
      passed(
        "Rendered desktop/mobile: login, WO drilldown, MO factory projection, class configuration, no page errors",
      );
    } finally {
      await Promise.race([
        browser.close(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
  }
  const report =
    "C:/Users/HUAWEI/Documents/AUTINBERG-Deliveries/fulfillment-20261005/evidence";
  mkdirSync(report, { recursive: true });
  writeFileSync(
    path.join(report, "chain-tests.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        environment: "isolated PostgreSQL + actual Express",
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: results.length,
      failed: 0,
      productionMutated: false,
    }),
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
  }
  await pool.end();
  if (started) await local.stop();
}
