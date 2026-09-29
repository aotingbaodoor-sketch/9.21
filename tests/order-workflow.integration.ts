import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { chromium, expect, type Browser } from '@playwright/test';
import { localPostgres } from "../scripts/postgres-runtime.ts";
import { database, migrate } from "../server/db.ts";
import { createApp } from "../server/app.ts";
import { hashPassword } from "../server/domain.ts";
import { backup, restore } from "../server/backup.ts";

const root = path.join(os.tmpdir(), "autinberg-order-gates", randomUUID());
await mkdir(root, { recursive: true });
const secret = randomBytes(32).toString("hex"),
  password = randomBytes(24).toString("base64url");
const pg = await localPostgres({
  databaseDir: path.join(root, "postgres"),
  port: 55590,
  user: "postgres",
  password: secret,
  persistent: true,
  onLog: () => {},
  onError: () => {},
});
const pool = database(
    `postgresql://postgres:${secret}@127.0.0.1:55590/orders_test`,
  ),
  restored = database(
    `postgresql://postgres:${secret}@127.0.0.1:55590/orders_restore`,
  );
let server: Server | undefined,
  started = false;
let browser:Browser|undefined;
const origin = "http://127.0.0.1:4607";
type Agent = { cookie: string; csrf: string };
async function request(
  actor: Agent | null,
  url: string,
  body?: unknown,
  key: string = randomUUID(),
) {
  const res = await fetch(origin + "/api" + url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...(actor ? { Cookie: actor.cookie, "X-CSRF-Token": actor.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    data: await res.json(),
    cookie: res.headers.get("set-cookie"),
  };
}
async function ok(
  actor: Agent | null,
  url: string,
  body?: unknown,
  key?: string,
) {
  const r = await request(actor, url, body, key);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
async function login(email: string): Promise<Agent> {
  const r = await request(null, "/auth/login", { email, password });
  assert.equal(r.status, 200);
  return { cookie: r.cookie!.split(";")[0], csrf: r.data.csrf };
}
try {
  await pg.initialise();
  await pg.start();
  started = true;
  await pg.createDatabase("orders_test");
  await pg.createDatabase("orders_restore");
  await migrate(pool);
  await migrate(pool);
  await migrate(restored);
  const adminId = randomUUID(),
    salesId = randomUUID(),
    otherId = randomUUID(),
    factoryUser = randomUUID(),
    factoryId = randomUUID();
  const hash = await hashPassword(password);
  for (const [id, role, email] of [
    [adminId, "admin", "admin"],
    [salesId, "sales", "sales"],
    [otherId, "sales", "other"],
    [factoryUser, "factory", "factory"],
  ])
    await pool.query(
      "INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$2)",
      [id, role, email + "@test.invalid", hash],
    );
  const customerId = randomUUID(),
    projectId = randomUUID(),
    quoteId = randomUUID(),
    quoteOrder = randomUUID(),
    orderId = randomUUID(),
    itemId = randomUUID(), otherItemId=randomUUID();
  await pool.query(
    "INSERT INTO customers(id,owner_id,company,grade,stage,next_follow_up) VALUES($1,$2,'Isolated gate test','C','新询盘','2026-09-26')",
    [customerId, salesId],
  );
  await pool.query(
    "INSERT INTO quotation_projects(id,customer_id,name,created_by) VALUES($1,$2,'Isolated gate test',$3)",
    [projectId, customerId, adminId],
  );
  await pool.query(
    "INSERT INTO quotation_versions(id,project_id,number,input,snapshot,customer_snapshot,reason,status,issued_at,created_by) VALUES($1,$2,1,'{}','{\"issues\":[],\"total\":100}','{}','TEST','confirmed',now(),$3)",
    [quoteId, projectId, adminId],
  );
  await pool.query(
    "INSERT INTO quotation_orders(id,project_id,quote_id,snapshot,created_by) VALUES($1,$2,$3,'{}',$4)",
    [quoteOrder, projectId, quoteId, adminId],
  );
  await pool.query(
    "INSERT INTO sales_orders(id,quotation_order_id,order_number,created_by) VALUES($1,$2,'TEST-ORDER',$3)",
    [orderId, quoteOrder, adminId],
  );
  await pool.query(
    "INSERT INTO sales_order_items(id,sales_order_id,line_key,configuration_snapshot,quantity) VALUES($1,$2,'line','{}',1)",
    [itemId, orderId],
  );
  await pool.query("INSERT INTO sales_order_items(id,sales_order_id,line_key,configuration_snapshot,quantity) VALUES($1,$2,'other-factory-line','{}',1)",[otherItemId,orderId]);
  await pool.query("INSERT INTO factories(id,name) VALUES($1,'TEST factory')", [
    factoryId,
  ]);
  await pool.query(
    "INSERT INTO factory_users(factory_id,user_id,status) VALUES($1,$2,'approved')",
    [factoryId, factoryUser],
  );
  server = createApp(pool, { origin, serveStatic:true }).listen(4607, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const admin = await login("admin@test.invalid"),
    sales = await login("sales@test.invalid"),
    other = await login("other@test.invalid"),
    factory = await login("factory@test.invalid");
  const endpoint = `/supply/orders/${orderId}`,
    draft = { factoryId, itemIds: [itemId], promisedDate: null };
  assert.equal(
    (await request(admin, endpoint + "/purchase-orders", draft)).status,
    409,
  );
  assert.equal((await request(other, endpoint + "/workflow")).status, 404);
  assert.equal(
    (
      await request(other, endpoint + "/evidence", {
        kind: "instruction",
        note: "test instruction",
      })
    ).status,
    404,
  );
  const deposit = {
    kind: "deposit",
    amount: 20,
    currency: "USD",
    receivedAt: new Date().toISOString(),
    reference: "TEST bank receipt only",
  };
  assert.equal(
    (await request(sales, endpoint + "/evidence", deposit)).status,
    403,
  );
  assert.equal(
    (
      await request(admin, endpoint + "/evidence", {
        ...deposit,
        state: "生产中",
      })
    ).status,
    400,
  );
  // Existing isolated browser regression harness; no real accounts or data.
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/login');
  await page.getByLabel('邮箱',{exact:true}).fill('admin@test.invalid');
  await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page).not.toHaveURL(/login/);
  await page.goto(origin+'/supply');
  await page.getByRole('button',{name:/TEST-ORDER/}).click();
  await expect(page.getByRole('button',{name:'创建工厂采购草稿',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'正式下达生产指令',exact:true})).toBeDisabled();
  await page.getByLabel('到账金额',{exact:true}).fill('20');
  await page.getByLabel('实际到账时间',{exact:true}).fill('2026-09-01T10:00');
  await page.getByLabel('到账凭据或银行流水说明',{exact:true}).fill('ISOLATED UI test deposit');
  await page.getByRole('button',{name:'确认定金已到账',exact:true}).click();
  await expect(page.getByRole('heading',{name:'业务阶段：已收定金',exact:true})).toBeVisible();
  await page.getByRole('heading',{name:'业务阶段：已收定金',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'order-deposit-desktop.png'),fullPage:false});
  const key = randomUUID(),
    first = await ok(admin, endpoint + "/evidence", deposit, key);
  assert.deepEqual(
    await ok(admin, endpoint + "/evidence", deposit, key),
    first,
  );
  assert.equal(first.state, "已收定金");
  const po = (await ok(admin, endpoint + "/purchase-orders", draft)).id;
  const confirm = {
    price: 100,
    promisedDate: "2027-01-01",
    note: "TEST confirm",
    version: 1,
  };
  assert.equal(
    (await request(factory, `/supply/purchase-orders/${po}/confirm`, confirm))
      .status,
    409,
  );
  assert.equal(
    (
      await request(admin, endpoint + "/evidence", {
        kind: "instruction",
        note: "TEST instruction",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(admin, endpoint + "/evidence", {
        kind: "measurement",
        fileId: randomUUID(),
        note: "missing file",
      })
    ).status,
    422,
  );
  const fileId = randomUUID();
  await pool.query(
    "INSERT INTO quotation_files(id,project_id,user_id,name,mime,bytes_base64,sha256,kind) VALUES($1,$2,$3,'TEST measurement.pdf','application/pdf','JVBERi0=','testhash','technical')",
    [fileId, projectId, adminId],
  );
  const measurement = (
    await ok(admin, endpoint + "/evidence", {
      kind: "measurement",
      fileId,
      note: "TEST uploaded measurement",
    })
  ).id;
  assert.equal(
    (
      await request(admin, endpoint + "/evidence", {
        kind: "instruction",
        note: "TEST missing dimensions",
      })
    ).status,
    409,
  );
  const dimensions = {
    kind: "dimensions",
    measurementId: measurement,
    lines: [{ itemId, widthMm: 1100, heightMm: 2200 },{itemId:otherItemId,widthMm:3300,heightMm:2400}],
    note: "TEST final verified dimensions",
  };
  assert.equal(
    (
      await request(admin, endpoint + "/evidence", {
        ...dimensions,
        lines: [{ itemId: randomUUID(), widthMm: 10, heightMm: 20 }],
      })
    ).status,
    422,
  );
  assert.equal(
    (await ok(admin, endpoint + "/evidence", dimensions)).state,
    "已量尺",
  );
  assert.equal(
    (await request(factory, `/supply/purchase-orders/${po}/confirm`, confirm))
      .status,
    409,
  );
  const issued = await Promise.all([
    request(admin, endpoint + "/evidence", {
      kind: "instruction",
      note: "TEST issue A",
    }),
    request(admin, endpoint + "/evidence", {
      kind: "instruction",
      note: "TEST issue B",
    }),
  ]);
  assert.deepEqual(issued.map((x) => x.status).sort(), [200, 409]);
  await ok(factory, `/supply/purchase-orders/${po}/confirm`, confirm);
  const factoryView = await ok(factory, `/supply/purchase-orders/${po}`);
  assert.deepEqual(
    factoryView.productionInstruction.dimensions,
    [dimensions.lines[0]],
  );
  assert.ok(
    !JSON.stringify(factoryView.productionInstruction).includes(
      "TEST bank receipt",
    ),
  );
  await ok(factory, `/supply/purchase-orders/${po}/updates`, {
    stage: "materials",
    plannedAt: null,
    actualAt: new Date().toISOString(),
    quantity: 1,
    note: "TEST real API feedback",
  });
  assert.equal(
    (
      await request(admin, endpoint + "/evidence", {
        kind: "measurement",
        fileId,
        note: "TEST forbidden later replacement",
      })
    ).status,
    409,
  );
  const workflow = await ok(sales, endpoint + "/workflow");
  assert.equal(workflow.state, "生产中");
  assert.equal(workflow.events.length, 4);
  assert.ok(
    workflow.records.every((r: { data?: unknown }) => r.data === undefined),
  );
  assert.ok(
    workflow.events.every(
      (e: { basis: { label: string } }) => e.basis.label === "系统自动通过",
    ),
  );
  await assert.rejects(
    pool.query("DELETE FROM order_evidence WHERE sales_order_id=$1", [orderId]),
    /不可修改或删除/,
  );
  await assert.rejects(
    pool.query(
      "UPDATE order_milestone_events SET to_state='已发货' WHERE sales_order_id=$1",
      [orderId],
    ),
    /不可修改或删除/,
  );
  await page.reload();
  await page.getByRole('button',{name:/TEST-ORDER/}).click();
  await expect(page.getByRole('heading',{name:'业务阶段：生产中',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'正式下达生产指令',exact:true})).toBeDisabled();
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('heading',{name:'业务阶段：生产中',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'order-mobile.png'),fullPage:false});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.deepEqual(errors,[]);
  console.log('PASS browser: admin deposit form, disabled missing-evidence controls, server-updated milestone, issued instruction locked, desktop + 390px, no page errors. Artifacts:',root);
  await browser.close();browser=undefined;
  const archive = await backup(pool);
  await restore(restored, archive);
  assert.equal(
    (
      await restored.query(
        "SELECT count(*)::int AS n FROM order_milestone_events",
      )
    ).rows[0].n,
    4,
  );
  assert.equal(
    (
      await restored.query(
        "SELECT count(*)::int AS n FROM order_evidence WHERE kind='instruction'",
      )
    ).rows[0].n,
    1,
  );
  console.log(
    "PASS actual HTTP + PostgreSQL: permissions, draft deposit gate, measurements, final dimensions, explicit instruction, concurrent issue, idempotency, immutable audit, redaction, independent restore. Production untouched.",
  );
} finally {
  await browser?.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((e) => (e ? reject(e) : resolve())),
    );
  await pool.end();
  await restored.end();
  if (started) await pg.stop();
}
