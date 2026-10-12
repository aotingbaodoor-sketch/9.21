// Isolated PostgreSQL + actual CRM endpoints. No production writes, contacts or notifications.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";
import { localPostgres } from "../scripts/postgres-runtime.ts";
import { database, migrate } from "../server/db.ts";
import { createApp } from "../server/app.ts";
import { hashPassword } from "../server/domain.ts";
import {
  allocatePartner,
  allocateCustomerCode,
} from "../server/customer-code-store.ts";
import { backup, restore } from "../server/backup.ts";
import { quoteHtml } from "../server/quoting/pdf.ts";
import { fixtures, today, future } from "./quoting.fixtures.ts";
import {
  createPricingWorker,
  FX_BACKUP_URL,
  parseFxBackup,
} from "../server/pricing/sync.ts";
import { ensureSources } from "../server/tariffs/sources.ts";
import {createLogisticsExpiryWorker} from '../server/logistics/expiry.ts';
const root = mkdtempSync(path.join(os.tmpdir(), "autinberg-logistics-")),
  password = randomBytes(24).toString("hex"),
  origin = "http://127.0.0.1:4632";
const artifacts = process.env.ARTIFACT_DIR || path.join(root, "evidence");
mkdirSync(artifacts, { recursive: true });
const local = await localPostgres({
  databaseDir: path.join(root, "pg"),
  port: 55632,
  user: "postgres",
  password,
  persistent: true,
  fastIsolatedInit: true,
  onLog: () => {},
  onError: () => {},
});
const pool = database(
    `postgresql://postgres:${password}@127.0.0.1:55632/logistics_test`,
  ),
  target = database(
    `postgresql://postgres:${password}@127.0.0.1:55632/logistics_restore`,
  );
type Actor = { cookie: string; csrf: string };
let server: Server | undefined,
  started = false;
const results: { name: string; status: string }[] = [];
const pass = (name: string) => {
  results.push({ name, status: "passed" });
  console.log("PASS", name);
};
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
    data: r.headers.get("content-type")?.includes("application/json") ? await r.json() : Buffer.from(await r.arrayBuffer()),
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
try {
  await local.initialise();
  await local.start();
  started = true;
  await local.createDatabase("logistics_test");
  await local.createDatabase("logistics_restore");
  await migrate(pool);
  await migrate(target);
  await migrate(pool);
  await ensureSources(pool);
  const roles = [
      "admin",
      "sales",
      "coordinator",
      "logistics",
      "technical",
      "factory",
    ],
    ids: Record<string, string> = {},
    actors: Record<string, Actor> = {},
    hash = await hashPassword(password);
  for (const role of roles) {
    ids[role] = randomUUID();
    await pool.query(
      "INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$2)",
      [ids[role], role, `${role}@logistics.invalid`, hash],
    );
  }
  if (process.argv.includes("--ui")) {
    await cp(path.resolve("dist"), path.join(root, "dist"), {
      recursive: true,
    });
    process.chdir(root);
  }
  server = createApp(pool, {
    origin,
    serveStatic: process.argv.includes("--ui"),
  }).listen(4632, "127.0.0.1");
  for (const role of roles) {
    const r = await req(null, "/auth/login", {
      email: `${role}@logistics.invalid`,
      password,
    });
    assert.equal(r.status, 200);
    actors[role] = { cookie: r.cookie, csrf: r.data.csrf };
  }
  const { admin, sales, coordinator, logistics, technical, factory } = actors;
  const rate = {
    name: "TEST domestic cost",
    kind: "domestic",
    country: "US",
    transport: "sea",
    currency: "CNY",
    unit: "fixed",
    rate: 100,
    minimum: 0,
    validFrom: today,
    validUntil: future,
    sourceDate: today,
    provider: "ISOLATED TEST provider",
    evidence: "https://example.invalid/quotation",
    scope: "TEST freight terms, not commercial",
  };
  assert.equal((await req(null, "/logistics/rates")).status, 401);
  assert.equal((await req(technical, "/logistics/rates")).status, 403);
  assert.equal((await req(factory, "/logistics/rates")).status, 403);
  assert.equal(
    (
      await req(sales, "/logistics/rates", {
        data: rate,
        reason: "TEST disallowed",
      })
    ).status,
    403,
  );
  assert.equal((await req(coordinator, "/customers")).status, 403);
  assert.equal(
    (
      await req(
        coordinator,
        "/logistics/policy",
        { data: {}, version: 1, reason: "TEST disallowed" },
        "PUT",
      )
    ).status,
    403,
  );
  const key = randomUUID(),
    rateBody = { data: rate, reason: "TEST first real API entry" },
    first = await ok(coordinator, "/logistics/rates", rateBody, "POST", key);
  assert.deepEqual(
    await ok(coordinator, "/logistics/rates", rateBody, "POST", key),
    first,
  );
  const list = await ok(sales, "/logistics/rates");
  assert.equal(list[0].name, rate.name);
  for (const k of ["rate", "minimum", "evidence", "taxBase", "priorTaxes"])
    assert.ok(!(k in list[0]), k);
  await ok(logistics, "/logistics/rates");
  assert.equal((await req(logistics, "/logistics/products")).status, 403);
  await ok(coordinator, "/tariffs");
  await ok(coordinator, "/pricing/overview");
  pass(
    "管理员/跟单员/物流/销售/技术/工厂/匿名权限、CSRF与费率成本字段隔离；幂等新增",
  );
  const f = fixtures();
  f.input.incoterm = "FOB";
  f.input.country = "US";
  f.input.currency = "CNY";
  f.input.freightId = null;
  f.input.lines[0].unitPrice = 2000;
  f.input.logistics = {
    rateIds: [first.id],
    transport: "sea",
    containers: 1,
    storageDays: 0,
    includedServices: [],
    scope: "TEST FOB seller obligations",
  };
  const exp = await ok(coordinator, "/logistics/rates", {
    data: { ...rate, name: "TEST export", kind: "export", rate: 200 },
    reason: "TEST export entry",
  });
  f.input.logistics.rateIds.push(exp.id);
  const c = await ok(admin, "/customers", {
    company: "ISOLATED LOGISTICS TEST",
    contact: "TEST contact",
    country: "US",
    grade: "A",
    ownerId: ids.sales,
  });
  const partner = await allocatePartner(pool, {
    userId: ids.sales,
    joinYear: 2026,
    name: "TEST first developer",
    market: "TEST",
  });
  await allocateCustomerCode(pool, {
    customerId: c.id,
    partnerId: partner.id,
    firstContactDate: today,
    source: "new",
  });
  await ok(admin, "/quoting/settings", { data: f.settings, version: 1 }, "PUT");
  f.product.id = (await ok(admin, "/quoting/products", f.product)).id;
  f.input.lines[0].productId = f.product.id;
  const project = (
    await ok(sales, "/quoting/projects", {
      customerId: c.id,
      name: "TEST logistics quote",
    })
  ).id;
  const preview = await ok(
    admin,
    `/quoting/projects/${project}/preview`,
    f.input,
  );
  assert.equal(preview.total, 6720, JSON.stringify(preview.issues));
  const low = structuredClone(f.input);
  low.lines[0].unitPrice = 1;
  const blocked = await ok(admin, `/quoting/projects/${project}/preview`, low);
  assert.equal(blocked.total, null);
  assert.ok(blocked.issues.some((v: any) => v.code === "G-35"));
  const missing = structuredClone(f.input);
  missing.logistics!.rateIds = [];
  assert.equal(
    (await ok(admin, `/quoting/projects/${project}/preview`, missing)).total,
    null,
  );
  const vkey = randomUUID(),
    body = { baseVersion: 1, input: f.input, reason: "TEST frozen logistics" },
    v = await ok(
      admin,
      `/quoting/projects/${project}/versions`,
      body,
      "POST",
      vkey,
    );
  assert.deepEqual(
    await ok(
      admin,
      `/quoting/projects/${project}/versions`,
      body,
      "POST",
      vkey,
    ),
    v,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM logistics_quote_sheets"))
      .rows[0].n,
    1,
  );
  assert.equal((await req(sales, `/logistics/sheets/${v.id}`)).status, 403);
  assert.equal((await req(sales, `/logistics/sheets/${v.id}/export`)).status, 403);
  const excelResponse = await req(admin, `/logistics/sheets/${v.id}/export`);
  assert.equal(excelResponse.status, 200);
  assert.equal(excelResponse.data.subarray(0, 2).toString(), "PK");
  assert.equal(
    (await req(coordinator, `/logistics/sheets/${v.id}`)).status,
    403,
  );
  await ok(admin, `/quoting/versions/${v.id}/submit`, { version: 1 });
  const issued = await ok(admin, `/quoting/versions/${v.id}/issue`, {
    version: 2,
  });
  assert.ok(issued.docNo);
  const saved = (
    await pool.query("SELECT * FROM quotation_versions WHERE id=$1", [v.id])
  ).rows[0];
  saved.doc_no = issued.docNo;
  const html = quoteHtml(saved, "quotation", "both"),
    htmlHash = createHash("sha256").update(html).digest("hex"),
    snapshot = JSON.stringify(saved.snapshot);
  for (const forbidden of [
    "riskCny",
    "costCny",
    "landedMultiplier",
    "logistics_cost_rates",
  ])
    assert.ok(!html.includes(forbidden));
  assert.ok(html.includes(issued.docNo));
  pass(
    "实际报价API：计算6720 CNY、G31/G35硬拦截、保存T44、重复请求同编号、签发QT和PDF模板编号一致",
  );
  const draft = await ok(admin, `/quoting/projects/${project}/versions`, {
    baseVersion: 2,
    input: f.input,
    reason: "TEST change detection",
  });
  const next = await ok(coordinator, `/logistics/rates/${first.id}/version`, {
    data: { ...rate, rate: 120 },
    reason: "TEST actual supplier change",
  });
  assert.equal(next.version, 2);
  assert.equal(
    (await req(admin, `/quoting/versions/${draft.id}/submit`, { version: 1 }))
      .status,
    409,
  );
  const after = (
    await pool.query("SELECT * FROM quotation_versions WHERE id=$1", [v.id])
  ).rows[0];
  after.doc_no = issued.docNo;
  assert.equal(JSON.stringify(after.snapshot), snapshot);
  assert.equal(
    createHash("sha256")
      .update(quoteHtml(after, "quotation", "both"))
      .digest("hex"),
    htmlHash,
  );
  await assert.rejects(
    pool.query(
      "UPDATE logistics_quote_sheets SET snapshot='{}' WHERE quote_id=$1",
      [v.id],
    ),
  );
  await assert.rejects(
    pool.query("UPDATE logistics_cost_rates SET data='{}' WHERE id=$1", [
      first.id,
    ]),
  );
  const pbefore = (
    await pool.query("SELECT version FROM quotation_products WHERE id=$1", [
      f.product.id,
    ])
  ).rows[0].version;
  await ok(coordinator, `/logistics/products/${f.product.id}/cost`, {
    version: pbefore,
    cost: 220,
    guide: 350,
    sourceDate:today,
    validFrom: today,
    validUntil: future,
    provider: "TEST supplier",
    evidence: "https://example.invalid/cost",
    reason: "TEST supplier cost upgrade",
  });
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM logistics_price_history WHERE entity='quotation_products' AND entity_id=$1",
        [f.product.id],
      )
    ).rows[0].n,
    2,
  );
  pass(
    "费率/产品升版留存、G36草稿提示、已发报价与PDF源内容哈希不变、数据库冻结快照不可改",
  );
  const pol = await ok(admin, "/logistics/policy");
  await ok(
    admin,
    "/logistics/policy",
    {
      version: pol.version,
      data: { landedMultiplier: 1.18, floorMultiplier: 1.2 },
      reason: "TEST policy audit",
    },
    "PUT",
  );
  assert.equal(
    (await ok(admin, "/logistics/policy")).data.landedMultiplier,
    1.18,
  );
  assert.equal(
    (
      await req(
        admin,
        "/logistics/policy",
        {
          version: pol.version,
          data: { landedMultiplier: 1.2 },
          reason: "TEST conflict",
        },
        "PUT",
      )
    ).status,
    409,
  );
  const headers =
    "名称,费用类型,国家,起运港,目的地,运输方式,币种,单位,费率,最低收费,生效日期,失效日期,来源日期,提供方,凭证链接,适用说明\n";
  const csv =
    headers +
    `TEST batch,storage,US,,,sea,CNY,day,4,0,${today},${future},${today},TEST,https://example.invalid/rate,TEST manual verified\n`;
  const imp = await ok(coordinator, "/logistics/import-preview", {
    name: "test.csv",
    data: Buffer.from(csv).toString("base64"),
  });
  assert.deepEqual(imp.rows[0].errors, []);
  assert.equal(imp.rows[0].data.validFrom,today);
  assert.equal(imp.rows[0].data.sourceDate,today);
  assert.equal(imp.rows[0].data.validUntil,future);
  await ok(coordinator, `/logistics/imports/${imp.id}/commit`, {});
  const repeatedPreview = await ok(coordinator, "/logistics/import-preview", {
    name: "same.csv", data: Buffer.from(csv).toString("base64"),
  });
  assert.equal(repeatedPreview.rows[0].duplicate, true);
  await ok(coordinator, `/logistics/imports/${repeatedPreview.id}/commit`, {});
  assert.equal((await pool.query("SELECT count(*)::int n FROM logistics_cost_rates WHERE data->>'name'='TEST batch'")).rows[0].n, 1);
  assert.equal(
    (await ok(coordinator, `/logistics/imports/${imp.id}/commit`, {}))
      .alreadyCommitted,
    true,
  );
  const bad = await ok(coordinator, "/logistics/import-preview", {
    name: "bad.csv",
    data: Buffer.from(
      headers +
        "bad,storage,US,,,sea,CNY,day,,,,,,TEST,https://example.invalid,TEST\n",
    ).toString("base64"),
  });
  assert.ok(bad.rows[0].errors.length);
  assert.equal(
    (await req(coordinator, `/logistics/imports/${bad.id}/commit`, {})).status,
    422,
  );
  pass("底线系数即时生效和乐观锁、CSV错误行预览、原文件留存、确认幂等导入");
  const supplier=randomUUID();await pool.query('INSERT INTO factories(id,name) VALUES($1,$2)',[supplier,'ISOLATED MAT FACTORY']);
  const matData={factoryId:supplier,supplierCode:'TEST-PART',name:'测试五金',specification:'TEST isolated specification',unit:'piece',currency:'CNY',cost:20,sourceDate:today,validFrom:today,validUntil:future,provider:'ISOLATED MAT FACTORY',evidence:'https://example.invalid/material-proof'};
  assert.equal((await req(sales,'/logistics/materials')).status,403);
  assert.equal((await req(logistics,'/logistics/materials')).status,403);
  const mat=await ok(coordinator,'/logistics/materials',{data:matData,reason:'TEST real API material fixture'});
  assert.equal((await ok(coordinator,'/logistics/materials',{data:matData,reason:'TEST repeat no duplicate'})).id,mat.id);
  const materialProduct=(await ok(admin,'/quoting/products',{...f.product,sku:'TEST-MATERIAL',options:[]})).id;
  const optionCsv=`产品型号,选装ID,配置组,中文名称,英文名称,计价基准,成本CNY,销售加价CNY,必选,来源日期,生效日期,失效日期,提供方,凭证链接,变更原因\r\nTEST-MATERIAL,hardware,五金,测试五金,TEST hardware,one,20,80,false,${today},${today},${future},TEST supplier,https://example.invalid/options,TEST option cost import\r\n`;
  const optionPreview=await ok(coordinator,'/logistics/cost-import-preview',{kind:'options',name:'options.csv',data:Buffer.from(optionCsv).toString('base64')});assert.deepEqual(optionPreview.rows[0].errors,[]);
  assert.equal((await req(logistics,`/logistics/imports/${optionPreview.id}/commit`,{})).status,404);
  await ok(coordinator,`/logistics/cost-imports/${optionPreview.id}/commit`,{});
  assert.equal((await ok(coordinator,`/logistics/cost-imports/${optionPreview.id}/commit`,{})).alreadyCommitted,true);
  const mProduct=(await ok(coordinator,'/logistics/products')).find((p:any)=>p.id===materialProduct);
  await ok(coordinator,'/logistics/material-link',{productId:materialProduct,version:mProduct.version,optionId:'hardware',materialId:mat.id,coefficient:2,reason:'TEST 2 pieces per finished piece'});
  const linked=(await ok(coordinator,'/logistics/products')).find((p:any)=>p.id===materialProduct);
  assert.equal(linked.data.options[0].cost,40);assert.equal(linked.data.options[0].sale,80);assert.equal(linked.data.options[0].material.version,1);
  const salesProducts=await ok(sales,'/quoting/products');assert.ok(!JSON.stringify(salesProducts).includes('material-proof'));assert.ok(!JSON.stringify(salesProducts).includes('cnyPerUnit'));
  const materialInput=structuredClone(f.input);materialInput.incoterm='EXW';materialInput.customerForwarder=true;materialInput.logistics!.rateIds=[];materialInput.lines[0].productId=materialProduct;materialInput.lines[0].options=['hardware'];
  const mCalc=await ok(admin,`/quoting/projects/${project}/preview`,materialInput);assert.ok(mCalc.total>0);assert.ok(mCalc.issues.some((i:any)=>i.code==='option-review'));
  assert.equal(mCalc.costs.costCny,3300,'Material cost replaces a component, quantity applied exactly once');
  await ok(coordinator,'/logistics/materials',{data:{...matData,cost:21},previousId:mat.id,reason:'TEST supplier price revision'});
  const mStale=await ok(admin,`/quoting/projects/${project}/preview`,materialInput);assert.equal(mStale.total,null);assert.ok(mStale.issues.some((i:any)=>i.code==='G-36'));
  const noOptional=structuredClone(materialInput);noOptional.lines[0].options=[];assert.ok((await ok(admin,`/quoting/projects/${project}/preview`,noOptional)).total>0,'Unused optional material must not block standard products');
  assert.equal((await ok(coordinator,`/logistics/materials/${mat.id}/history`)).length,2);
  await assert.rejects(pool.query("UPDATE logistics_materials SET data='{}' WHERE id=$1",[mat.id]));
  assert.equal(JSON.stringify((await pool.query('SELECT snapshot FROM quotation_versions WHERE id=$1',[v.id])).rows[0].snapshot),snapshot);
  const matCsv=`供应商名称,供应商物料码,名称,规格,单位,币种,采购单价,来源日期,生效日期,失效日期,提供方,凭证链接,变更原因\r\nISOLATED MAT FACTORY,TEST-SECOND,测试配件,TEST规格,piece,CNY,5,${today},${today},${future},TEST supplier,https://example.invalid/material,TEST material CSV import\r\n`;
  const matPreview=await ok(coordinator,'/logistics/cost-import-preview',{kind:'materials',name:'materials.csv',data:Buffer.from(matCsv).toString('base64')});assert.deepEqual(matPreview.rows[0].errors,[]);await ok(coordinator,`/logistics/cost-imports/${matPreview.id}/commit`,{});
  const badMaterial=await ok(coordinator,'/logistics/cost-import-preview',{kind:'materials',name:'materials.csv',data:Buffer.from(matCsv.replace(',5,',',,')).toString('base64')});assert.ok(badMaterial.rows[0].errors.length);assert.equal((await req(coordinator,`/logistics/cost-imports/${badMaterial.id}/commit`,{})).status,422);
  pass('物料/选装真实API：供应商关联、批量预览及错误行、重复提交、成本不重复相加、商务审批、升版G36、销售脱敏、历史QT不变');
  const data = Array.from({ length: 22 }, (_, i) => ({
    date: today,
    base: "EUR",
    quote: [
      "USD",
      "CNY",
      ...Array.from(
        { length: 20 },
        (_, j) => `X${String.fromCharCode(65 + j)}Z`,
      ),
    ][i],
    rate: i === 0 ? 1.2 : i === 1 ? 8.4 : 2,
  }));
  let failure = false,
    backupCalls = 0;
  const fx = createPricingWorker(pool, async (url) => {
    if (String(url) === FX_BACKUP_URL && !failure) {
      backupCalls++;
      return Response.json(data);
    }
    return new Response("not available", { status: 503 });
  });
  const due = () =>
    pool.query(
      "UPDATE pricing_sync_config SET next_run=now()-interval '1 second' WHERE id=1",
    );
  await due();
  await fx.tick();
  assert.equal(backupCalls, 1);
  let latest = (await pool.query("SELECT * FROM pricing_fx_batches")).rows;
  assert.equal(latest.length, 1);
  assert.equal(latest[0].cny_rates.USD, 7);
  const firstSync = latest[0].first_synced_at.toISOString();
  await due();
  await fx.tick();
  latest = (await pool.query("SELECT * FROM pricing_fx_batches")).rows;
  assert.equal(latest[0].first_synced_at.toISOString(), firstSync);
  assert.equal(
    (
      await pool.query(
        "SELECT status FROM pricing_sync_runs ORDER BY started_at DESC LIMIT 1",
      )
    ).rows[0].status,
    "unchanged",
  );
  failure = true;
  await due();
  await fx.tick();
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM pricing_fx_batches")).rows[0]
      .n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT status FROM pricing_sync_runs ORDER BY started_at DESC LIMIT 1",
      )
    ).rows[0].status,
    "failed",
  );
  pass(
    "实际云端worker：主源失败→备源、日期方向、无新数据、三次失败保留旧值与提醒（模拟上游，不冒充真实数据）",
  );
  if (process.argv.includes("--live")) {
    const response = await fetch(FX_BACKUP_URL, {
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 200);
    const live = parseFxBackup(await response.text());
    writeFileSync(
      path.join(artifacts, "live-fx.json"),
      JSON.stringify(
        {
          url: FX_BACKUP_URL,
          checkedAt: new Date().toISOString(),
          date: live.date,
          USD: live.cnyRates.USD,
          EUR: live.cnyRates.EUR,
          currencies: Object.keys(live.rates).length,
        },
        null,
        2,
      ),
    );
    pass("真实Frankfurter ECB备源HTTP及数值转换，非模拟");
  }
  const exwInput = { ...f.input, incoterm: "EXW", logistics: undefined },
    exwProject = (
      await ok(sales, "/quoting/projects", {
        customerId: c.id,
        name: "TEST EXW order",
      })
    ).id;
  const exwQuote = await ok(admin, `/quoting/projects/${exwProject}/versions`, {
    baseVersion: 1,
    input: exwInput,
    reason: "TEST EXW fulfillment",
  });
  await ok(admin, `/quoting/versions/${exwQuote.id}/submit`, { version: 1 });
  await ok(admin, `/quoting/versions/${exwQuote.id}/issue`, { version: 2 });
  await ok(admin, `/quoting/versions/${exwQuote.id}/confirm`, {
    version: 3,
    contact: "TEST customer",
    evidence: "TEST isolated customer confirmation",
  });
  assert.equal(
    (await req(admin, `/quoting/versions/${exwQuote.id}/sales-order`, {}))
      .status,
    409,
  );
  await ok(admin, `/quoting/versions/${exwQuote.id}/deposit`, {
    kind: "deposit",
    amount: 1000,
    currency: "CNY",
    receivedAt: new Date(Date.now() - 60000).toISOString(),
    reference: "ISOLATED TEST receipt, no real money",
  });
  const so = await ok(
    admin,
    `/quoting/versions/${exwQuote.id}/sales-order`,
    {},
  );
  const file = await ok(admin, `/quoting/projects/${exwProject}/files`, {
    kind: "confirmation",
    name: "test-confirmation.pdf",
    mime: "application/pdf",
    data: Buffer.from("%PDF-1.4\nISOLATED TEST ONLY\n%%EOF").toString("base64"),
  });
  const woBody = {
      salesOrderId: so.id,
      expectedDelivery: future,
      confirmationFileId: file.id,
      orderType: "bulk",
      tradeTerm: "EXW",
    },
    wo = await ok(admin, "/supply/chain", woBody);
  assert.equal(
    (await req(admin, "/supply/chain", { ...woBody, tradeTerm: "FOB" })).status,
    409,
  );
  const detail = await ok(admin, `/supply/chain/${wo.id}`);
  assert.equal(detail.progress.length, 22);
  const skipped = detail.progress.filter((p: any) => p.status === "n/a");
  assert.deepEqual(skipped.map((p: any) => p.stage_code).sort(), [
    "export_cleared",
    "loaded",
  ]);
  assert.ok(
    skipped.every(
      (p: any) => p.skip_reason && p.skipped_by === ids.admin && p.skipped_on,
    ),
  );
  await pool.query(
    "UPDATE crm_work_orders SET current_stage='picked_up' WHERE id=$1",
    [wo.id],
  ); // isolated fixture: test next-stage selection, not mark skipped nodes completed
  assert.equal(
    (await ok(admin, `/supply/chain/${wo.id}/settlement`)).next.code,
    "shipped",
  );
  assert.equal(
    (
      await req(admin, `/supply/chain/${wo.id}/verify-stage`, {
        stage: "loaded",
        fileId: file.id,
        note: "TEST forbidden skipped node",
        occurredAt: new Date().toISOString(),
      })
    ).status,
    409,
  );
  pass(
    "EXW真实开单链：QT→确认→定金门禁→SO→WO；22态保留，n/a原因/人/时间，历史术语不可改，顺序跳过不适用节点",
  );
  assert.equal((await req(sales,'/logistics/expiry')).status,403);
  assert.equal((await req(coordinator,'/logistics/expiry/check',{})).status,403);
  const expiryRate=await ok(coordinator,'/logistics/rates',{data:{...rate,name:'TEST due rate',validUntil:today},reason:'TEST expiry source'});
  const expiryWorker=createLogisticsExpiryWorker(pool);
  await expiryWorker.tick();
  let expiry=await ok(coordinator,'/logistics/expiry');
  assert.equal(expiry.alerts.find((a:any)=>a.entity_id===expiryRate.id)?.state,'due');
  const alertCount=expiry.alerts.length;
  await ok(admin,'/logistics/expiry/check',{});await expiryWorker.tick();
  assert.equal((await ok(coordinator,'/logistics/expiry')).alerts.length,alertCount);
  await pool.query("UPDATE automation_rule SET config=jsonb_set(config,'{time}','\"invalid\"'),next_run=now() WHERE code='logistics_expiry'");
  await expiryWorker.tick();
  expiry=await ok(coordinator,'/logistics/expiry');
  assert.equal(expiry.alerts.length,alertCount);assert.equal(expiry.runs[0].status,'failed');assert.ok(expiry.rule.last_error);
  assert.equal((await pool.query('SELECT data FROM logistics_cost_rates WHERE id=$1',[expiryRate.id])).rows[0].data.validUntil,today);
  await ok(admin,'/logistics/expiry',{version:expiry.rule.version,enabled:true,config:{time:'07:30',timezone:'Asia/Shanghai',warningDays:7}},'PUT');
  await ok(coordinator,`/logistics/rates/${expiryRate.id}/version`,{data:{...rate,name:'TEST due rate',validUntil:future},reason:'TEST actual renewal'});
  await ok(admin,'/logistics/expiry/check',{});await expiryWorker.tick();
  expiry=await ok(coordinator,'/logistics/expiry');assert.ok(!expiry.alerts.some((a:any)=>a.entity_id===expiryRate.id));
  pass('云端到期任务：岗位隔离、重复执行去重、失败保留旧提醒/旧费率、15分钟重试、真实升版后解除提醒');
  const archive = await backup(pool);
  const restored = await restore(target, archive);
  assert.equal(restored.logistics_quote_sheets, 3);
  assert.ok(restored.logistics_expiry_runs>=4);
  assert.equal(
    (
      await target.query(
        "SELECT snapshot FROM logistics_quote_sheets WHERE quote_id=$1",
        [v.id],
      )
    ).rows[0].snapshot.ruleVersion,
    "logistics-1.1",
  );
  await assert.rejects(restore(target, archive));
  pass("新表随数据库备份、隔离恢复保留费率及冻结快照；非空库恢复被拦截");
  if (process.argv.includes("--ui")) {
    const { chromium } = await import("playwright");
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
        .fill("coordinator@logistics.invalid");
      await page.getByLabel("密码", { exact: true }).fill(password);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL("**/dashboard");
      await page.goto(origin + "/logistics-costs");
      await page
        .getByRole("heading", { name: "真实费率版本（T42 / T43）" })
        .waitFor();
      await page
        .getByRole("button", { name: "录入真实费率", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "新增费率", exact: true })
        .waitFor();
      await page.screenshot({
        path: path.join(artifacts, "logistics-desktop.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page
        .getByRole("button", { name: "产品采购成本 / 配置选装", exact: true })
        .click();
      await page.getByLabel("选择维护成本的产品").selectOption(f.product.id);
      await page.getByLabel("P-COST 实际采购成本").waitFor();
      await page.getByRole('button',{name:'物料成本与选装导入',exact:true}).click();
      await page.getByRole('heading',{name:'MAT物料成本与供应商报价',exact:true}).waitFor();
      await page.getByRole('button',{name:'新增物料报价',exact:true}).click();
      await page.getByLabel('采购单价',{exact:true}).waitFor();
      await page.screenshot({path:path.join(artifacts,'material-costs.png'),fullPage:true});
      await page.getByRole("button", { name: "到期提醒与后台检查", exact: true }).click();
      await page.getByRole("heading", { name: "实际运行记录", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "立即检查", exact: true }).count(), 0);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: path.join(artifacts, "logistics-mobile.png"),
        fullPage: false,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.reload();
      await page
        .getByRole("heading", { name: "成本与物流计价", exact: true })
        .waitFor();
      assert.deepEqual(errors, []);
      pass("浏览器跟单员登录、费率表/录入/成本表、到期记录及管理员操作隔离、手机布局、刷新与控制台");
    } finally {
      await browser.close();
    }
  }
  writeFileSync(
    path.join(artifacts, "logistics-tests.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        environment: "isolated actual CRM + PostgreSQL",
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
  if (started) await local.stop();
}
