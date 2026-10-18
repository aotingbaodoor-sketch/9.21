// ISOLATED DATABASE ONLY: tests the actual Express routes, database migrations and numbering service.
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
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
import {
  tcFieldsSchema,
  tcBusinessSchema,
  TC_FIELDS,
} from "../shared/technical.ts";
import { fixtures, today } from "./quoting.fixtures.ts";
import { calculate, policy } from "../server/quoting/engine.ts";
import { PDFDocument } from "pdf-lib";
import sharp from 'sharp';
import {expect} from '@playwright/test';
import {uiSession,uiProject,uiTc,uiDrawing,uiConfirm,uiDraft,uiReview,uiWrongTechnical,uiIssue} from './technical-ui.ts';
const out =
  "C:/Users/HUAWEI/Documents/AUTINBERG-Deliveries/tc-mo-completion-20261018/evidence";
mkdirSync(out, { recursive: true });
const root = mkdtempSync(path.join(os.tmpdir(), "autinberg-chain-")),
  password = randomBytes(32).toString("base64url");
const local = await localPostgres({
  databaseDir: path.join(root, "pg"),
  port: 55635,
  user: "postgres",
  password,
  persistent: true,
  fastIsolatedInit: true,
  onLog: () => {},
  onError: () => {},
});
const pool = database(
  `postgresql://postgres:${password}@127.0.0.1:55635/technical_test`,
);
const origin = "http://127.0.0.1:4635";
let server: Server | undefined,
  started = false;
let ui:Awaited<ReturnType<typeof uiSession>>|undefined;
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
    data: response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : Buffer.from(await response.arrayBuffer()),
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
  await local.createDatabase("technical_test");
  await migrate(pool);
  await migrate(pool);
  passed("028/029 additive migrations apply twice without duplicate changes");
  const adminId = randomUUID(),
    salesId = randomUUID(),
    otherId = randomUUID(),
    factoryUser = randomUUID(),
    otherFactoryUser = randomUUID(),
    hash = await hashPassword(password);
  for (const [id, role, email] of [
    [adminId, "admin", "admin"],
    [salesId, "sales", "sales"],
    [otherId, "sales", "other"],
    [factoryUser, "factory", "factory"],
    [otherFactoryUser, "factory", "otherfactory"],
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
    4635,
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
    factory = await login("factory"),
    otherFactory = await login("otherfactory");
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
  const factoryId = randomUUID();
  await pool.query("INSERT INTO factories(id,name) VALUES($1,$2)", [
    factoryId,
    "ISOLATED factory",
  ]);
  await pool.query(
    "INSERT INTO factory_users(factory_id,user_id,status) VALUES($1,$2,'approved')",
    [factoryId, factoryUser],
  );
  assert.equal((await ok(admin,'/supply/technical')).availability.reason,'no_projects');
  if(process.argv.includes('--ui'))ui=await uiSession(origin,password);
  for (const [kindIndex, kind] of ["door", "window", "wall_panel"].entries()) {
    const customer = await ok(admin, "/customers", {
      company: "ISOLATED Private Buyer " + kind,
      ownerId: salesId,
      email: kind + "@private.invalid",
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
    const projectId = ui?await uiProject(ui.page,origin,customer.id,'ISOLATED '+kind):randomUUID();
    const quoteId = randomUUID(),
      quoteOrder = randomUUID(),
      orderId = randomUUID(),
      itemId = randomUUID();
    if(!ui)await pool.query(
      "INSERT INTO quotation_projects(id,customer_id,name,created_by) VALUES($1,$2,'ISOLATED chain',$3)",
      [projectId, customer.id, adminId],
    );
    const f = fixtures();
    f.input.incoterm = "EXW";
    f.input.freightId = null;
    f.input.lines[0].key = "Door-01";
    f.input.lines[0].quantity = 2;
    f.input.lines[0].width = 1000;
    f.input.lines[0].height = 2000;
    const calculation = calculate(
      f.input,
      [f.product],
      null,
      f.settings,
      policy(f.settings, { id: adminId, role: "admin" }),
      today,
      projectId,
    );
    await pool.query(
      "INSERT INTO quotation_versions(id,project_id,number,input,snapshot,customer_snapshot,reason,status,issued_at,created_by) VALUES($1,$2,1,$3,$4,$5,$6,$7,now(),$8)",
      [
        quoteId,
        projectId,
        JSON.stringify(f.input),
        JSON.stringify(calculation),
        "{}",
        "ISOLATED",
        "confirmed",
        adminId,
      ],
    );
    await pool.query(
      "INSERT INTO quotation_orders(id,project_id,quote_id,snapshot,created_by) VALUES($1,$2,$3,$4,$5)",
      [
        quoteOrder,
        projectId,
        quoteId,
        JSON.stringify({ input: f.input, snapshot: calculation }),
        adminId,
      ],
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO sales_orders(id,quotation_order_id,order_number,created_by) VALUES($1,$2,'BLOCKED',$3)",
        [randomUUID(), quoteOrder, adminId],
      ),
    );
    // A historical SO allows us to verify WO rejection before financial evidence exists.
    await pool.query(
      "INSERT INTO sales_orders(id,quotation_order_id,order_number,created_by,deposit_gate_required) VALUES($1,$2,$3,$4,false)",
      [orderId, quoteOrder, "LEGACY-TEST-SO-" + kind, adminId],
    );
    if(kindIndex===0){
      const hidden=await ok(other,'/supply/technical');assert.equal(hidden.availability.reason,'no_permission');assert.equal(hidden.projects.length,0);
      await pool.query('UPDATE customers SET deleted_at=now() WHERE id=$1',[customer.id]);
      assert.equal((await ok(admin,'/supply/technical')).availability.reason,'archived_customer');
      if(ui){await ui.page.goto(origin+'/technical');await expect(ui.page.getByText(/已有项目的客户已归档/)).toBeVisible();}
      await pool.query('UPDATE customers SET deleted_at=NULL WHERE id=$1',[customer.id]);
      await pool.query("UPDATE sales_orders SET status='closed' WHERE id=$1",[orderId]);
      assert.equal((await ok(admin,'/supply/technical')).availability.reason,'closed_project');
      if(ui){await ui.page.goto(origin+'/technical');await expect(ui.page.getByText(/已有项目已关闭/)).toBeVisible();}
      await pool.query("UPDATE sales_orders SET status='confirmed' WHERE id=$1",[orderId]);
      if(ui){
        await ui.page.route('**/api/supply/technical',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'ISOLATED simulated loading failure'})}));
        await ui.page.goto(origin+'/technical');await expect(ui.page.getByRole('heading',{name:'TC项目加载失败'})).toBeVisible();
        await ui.page.unroute('**/api/supply/technical');await ui.page.getByRole('button',{name:'重新加载项目'}).click();await expect(ui.page.getByRole('heading',{name:'技术确认单 TC',exact:true})).toBeVisible();
      }
      passed('Empty project reasons: no projects, archived customer, closed project, access denied; simulated network failure and UI retry');
    }
    await pool.query(
      "INSERT INTO sales_order_items(id,sales_order_id,line_key,configuration_snapshot,quantity) VALUES($1,$2,'Door-01','{}',2)",
      [itemId, orderId],
    );
    const signed = await PDFDocument.create();
    signed.addPage().drawText("ISOLATED CUSTOMER SIGNED TC - TEST ONLY");
    const file = await ok(admin, `/quoting/projects/${projectId}/files`, {
      name: "ISOLATED confirmation.pdf",
      mime: "application/pdf",
      data: Buffer.from(await signed.save()).toString("base64"),
      kind: "confirmation",
    });
    const woInput = {
      salesOrderId: orderId,
      expectedDelivery: "2026-11-01",
      confirmationFileId: file.id,
      orderType: "bulk",
      tradeTerm: "EXW",
    };
    assert.equal((await request(admin, "/supply/chain", woInput)).status, 409);
    const poInput = {
      factoryId,
      itemIds: [itemId],
      promisedDate: "2026-10-30",
    };
    assert.equal(
      (
        await request(
          admin,
          `/supply/orders/${orderId}/purchase-orders`,
          poInput,
        )
      ).status,
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
      (
        await request(
          admin,
          `/supply/orders/${orderId}/purchase-orders`,
          poInput,
        )
      ).status,
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
      (await pool.query("SELECT count(*)::int n FROM crm_work_orders")).rows[0]
        .n,
      kindIndex + 1,
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
    assert.equal(
      (await request(other, `/supply/chain/${work.id}`)).status,
      404,
    );
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

    const tech = {
      items: [
        {
          lineKey: "Door-01",
          kind,
          quantity: 2,
          widthMm: 1000,
          heightMm: 2000,
          fields: tcFieldsSchema.parse({
            ...Object.fromEntries(
              Object.keys(TC_FIELDS).map((k) => [k, "TEST " + k]),
            ),
            glass: "TEST tempered glass",
            finalHardware: "UPGRADED H3 FINAL",
            certifications: "CE NFRC AAMA AS2047",
            thirdPartyTests: "Water penetration test",
            vi: "AUTINBERG",
            marks: identity.code,
          }),
        },
      ],
    };
    const business = tcBusinessSchema.parse({
      projectName: "SECRET PROJECT",
      country: "SECRET COUNTRY",
      port: "SECRET PORT",
      upgradeFees: "99999 SECRET",
      certificationPayer: "SECRET PAYER",
      certificationPeriod: "SECRET PERIOD",
      originalRequirements: {"Door-01": {special: "SECRET original private requirement"}},
    });
    const key = randomUUID(),
      body = {
        projectId,
        technical: tech,
        business,
        reason: "ISOLATED " + kind,
      };
    const uiCreated=ui?await uiTc(ui.page,origin,body):null;
    const tc = uiCreated?.value??await ok(admin, "/supply/technical", body, key);
    // Replay the actual browser request, not an altered fixture.
    assert.deepEqual(await ok(admin, "/supply/technical", uiCreated?.body??body,uiCreated?.key??key), tc);
    assert.equal(
      (await ok(admin, "/supply/technical")).records.length,
      kindIndex * 2 + 1,
    );
    assert.equal(
      (await request(other, "/supply/technical/" + tc.id)).status,
      404,
    );
    assert.equal(
      (await request(factory, "/supply/technical/" + tc.id)).status,
      404,
    );
    assert.equal(
      (await request(factory, "/quoting/files/" + file.id)).status,
      403,
    );
    assert.equal(
      (
        await request(admin, "/quoting/versions/" + quoteId + "/documents", {
          kind: "contract",
          language: "both",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(admin, "/supply/technical/" + tc.id + "/bind-quote", {
          quoteId,
        })
      ).status,
      409,
    );
    const production = {
      requiredDate: "2026-11-01",
      batch: "BATCH-1",
      process: "TEST process",
      packingMarks: identity.code,
      qualityPoints: "TEST water test",
    };
    const draftBody = {
      purchaseOrderId: po.id,
      tcId: tc.id,
      lines: [{ lineKey: "Door-01", quantity: 1 }],
      production,
    };
    const original=await PDFDocument.create();original.setTitle('SECRET CUSTOMER metadata');const sourcePage=original.addPage([600,400]);sourcePage.drawText('SECRET CUSTOMER +86123456789 signature address',{x:15,y:355,size:14});sourcePage.drawText('1000 x 2000 mm - STRUCTURE MUST STAY',{x:25,y:80,size:16});
    const originalBytes=Buffer.from(await original.save());
    const uiImage=ui?await uiDrawing(ui.page,origin,tc.id,originalBytes):null;
    const drawing=uiImage?.drawing??await ok(admin,`/supply/technical/${tc.id}/drawings`,{name:'SECRET customer original.pdf',mime:'application/pdf',data:originalBytes.toString('base64'),lineKeys:['Door-01']});
    const redaction=uiImage?.redaction??await ok(admin,`/supply/technical-drawings/${drawing.id}/redactions`,{baseVersion:0,rectangles:[{page:0,x:0,y:0,width:1,height:.34}],reason:'TEST privacy mask'});
    assert.equal((await request(factory,`/supply/technical-drawings/${drawing.id}/original`)).status,404);
    assert.equal((await request(other,`/supply/technical-drawings/${drawing.id}`)).status,404);
    assert.equal((await request(sales,`/supply/drawing-redactions/${redaction.id}/review`,{approved:true,note:'unauthorized',reviewedPages:[0],privacyRemoved:true,technicalPreserved:true})).status,403);
    const raster=await ok(admin,`/supply/drawing-redactions/${redaction.id}/pages/0`),originRaster=await ok(admin,`/supply/technical-drawings/${drawing.id}/pages/0`);
    const maskPixel=await sharp(raster).extract({left:100,top:100,width:1,height:1}).removeAlpha().raw().toBuffer();assert.deepEqual([...maskPixel],[0,0,0]);
    const meta=await sharp(raster).metadata(),bottom={left:0,top:Math.floor(meta.height!*.5),width:meta.width!,height:Math.floor(meta.height!*.4)};
    const pixelDigest=async(bytes:Buffer)=>createHash('sha256').update(await sharp(bytes).extract(bottom).removeAlpha().raw().toBuffer()).digest('hex');
    assert.equal(await pixelDigest(raster),await pixelDigest(originRaster),'Unmasked technical pixels must remain unchanged');
    assert.equal(meta.exif,undefined);writeFileSync(path.join(out,kind+'-redacted.png'),raster);
    assert.equal(
      (
        await request(
          admin,
          "/supply/chain/" + work.id + "/manufacturing-drafts",
          draftBody,
        )
      ).status,
      409,
    );
    if(ui)await uiConfirm(ui.page,origin,tc.id,file.id,today,quoteId);
    else {await ok(sales, "/supply/technical/" + tc.id + "/confirm", {
      fileId: file.id,
      signerName: "ISOLATED Buyer signature",
      signedOn: today,
      verified: true,
    });
    await ok(admin, "/supply/technical/" + tc.id + "/bind-quote", { quoteId });
    }
    assert.equal((await request(admin,`/supply/technical/${tc.id}/drawings`,{name:'new.pdf',mime:'application/pdf',data:originalBytes.toString('base64'),lineKeys:['Door-01']})).status,409);
    const draft = ui?await uiDraft(ui.page,origin,work.id,draftBody):await ok(
      admin,
      "/supply/chain/" + work.id + "/manufacturing-drafts",
      draftBody,
    );
    assert.equal(
      (
        await request(
          admin,
          "/supply/manufacturing-drafts/" + draft.id + "/issue",
          { revision: 1, partyAConfirmed: true },
        )
      ).status,
      409,
      "measurement gate",
    );
    const measurement = await ok(
      admin,
      "/supply/orders/" + orderId + "/evidence",
      { kind: "measurement", fileId: file.id, note: "ISOLATED measurements" },
    );
    await ok(admin, "/supply/orders/" + orderId + "/evidence", {
      kind: "dimensions",
      measurementId: measurement.id,
      lines: [{ itemId, widthMm: 1000, heightMm: 2000 }],
      note: "ISOLATED dimensions",
    });
    assert.equal((await request(admin,`/supply/manufacturing-drafts/${draft.id}/issue`,{revision:1,partyAConfirmed:true})).status,409,'unreviewed drawing gate');
    assert.equal((await request(admin,`/supply/drawing-redactions/${redaction.id}/review`,{approved:true,note:'incomplete checklist',reviewedPages:[],privacyRemoved:true,technicalPreserved:true})).status,422);
    if(ui)await uiReview(ui.page,origin,drawing.id,redaction.id);else await ok(admin,`/supply/drawing-redactions/${redaction.id}/review`,{approved:true,note:'TEST reviewed all pages',reviewedPages:[0],privacyRemoved:true,technicalPreserved:true});
    const changed = structuredClone(tech);
    changed.items[0].quantity = 1;
    changed.items[0].fields.finalHardware = "WRONG";
    if(ui)await uiWrongTechnical(ui.page,origin,draft.id);else await ok(
      admin,
      "/supply/manufacturing-drafts/" + draft.id,
      { revision: 1, technical: changed, production },
      undefined,
      "PUT",
    );
    assert.match(
      (
        await ok(admin, "/supply/manufacturing-drafts/" + draft.id)
      ).differences.join(" "),
      /五金/,
    );
    assert.equal(
      (
        await request(
          admin,
          "/supply/manufacturing-drafts/" + draft.id + "/issue",
          { revision: 2, partyAConfirmed: true },
        )
      ).status,
      409,
    );
    changed.items[0].fields.finalHardware = "UPGRADED H3 FINAL";
    await ok(
      admin,
      "/supply/manufacturing-drafts/" + draft.id,
      {
        revision: 2,
        technical: changed,
        production: {
          ...production,
          process: "ISOLATED Private Buyer " + kind,
        },
      },
      undefined,
      "PUT",
    );
    assert.equal(
      (
        await request(
          admin,
          "/supply/manufacturing-drafts/" + draft.id + "/issue",
          { revision: 3, partyAConfirmed: true },
        )
      ).status,
      422,
    );
    await ok(
      admin,
      "/supply/manufacturing-drafts/" + draft.id,
      { revision: 3, technical: changed, production },
      undefined,
      "PUT",
    );
    const uiIssued=ui?await uiIssue(ui.page,origin,draft.id):null;
    const issueKey = uiIssued?.key??randomUUID(),
      mo = uiIssued?.value??await ok(
        admin,
        "/supply/manufacturing-drafts/" + draft.id + "/issue",
        { revision: 4, partyAConfirmed: true },
        issueKey,
      );
    assert.deepEqual(
      await ok(
        admin,
        "/supply/manufacturing-drafts/" + draft.id + "/issue",
        { revision: 4, partyAConfirmed: true },
        issueKey,
      ),
      mo,
    );
    const view = await ok(factory, "/supply/manufacturing/" + mo.id);
    assert.equal(view.drawings.length,1);
    const drawingDownload=await ok(factory,`/supply/manufacturing/${mo.id}/drawings/${redaction.id}/download`);
    const cleanPdf=await PDFDocument.load(drawingDownload);assert.equal(cleanPdf.getPageCount(),1);assert.ok(!cleanPdf.getTitle()?.includes('SECRET'));
    assert.equal((await request(otherFactory,`/supply/manufacturing/${mo.id}/drawings/${redaction.id}/download`)).status,404);
    writeFileSync(path.join(out,kind+'-drawing.pdf'),drawingDownload);
    for (const route of ["/supply/manufacturing/"+mo.id, "/supply/manufacturing/"+mo.id+"/export/pdf", "/supply/purchase-orders/"+po.id]) {
      assert.ok([403,404].includes((await request(otherFactory,route)).status),route);
    }
    const purchaseView=await ok(factory,"/supply/purchase-orders/"+po.id);
    assert.ok(purchaseView.manufacturingOrders.some((m:any)=>m.id===mo.id));
    assert.deepEqual(Object.keys(purchaseView.items[0].configuration_snapshot).sort(),["key","quantity"]);
    assert.doesNotMatch(JSON.stringify(purchaseView),/SECRET|ISOLATED Private Buyer|@private.invalid/);
    assert.equal(
      view.technical.tcTechnical.items[0].fields.finalHardware,
      "UPGRADED H3 FINAL",
    );
    assert.equal(
      view.technical.tcTechnical.items[0].fields.certifications,
      "CE NFRC AAMA AS2047",
    );
    assert.equal(
      view.technical.tcTechnical.items[0].fields.thirdPartyTests,
      "Water penetration test",
    );
    for (const secret of [
      "SECRET",
      "ISOLATED Private Buyer",
      "buyer@private.invalid",
      "ISOLATED Buyer signature",
      "bytes_base64",
      "file_id",
    ])
      assert.ok(!JSON.stringify(view).includes(secret), secret);
    assert.equal(
      (await request(other, "/supply/manufacturing/" + mo.id)).status,
      404,
    );
    const concurrentDrafts = await Promise.all(
      Array.from({ length: 3 }, () =>
        ok(admin, "/supply/chain/" + work.id + "/manufacturing-drafts", {
          ...draftBody,
          production: { ...production, batch: "NEXT" },
        }),
      ),
    );
    const attempts = await Promise.all(
      concurrentDrafts.map((d) =>
        request(admin, "/supply/manufacturing-drafts/" + d.id + "/issue", {
          revision: 1,
          partyAConfirmed: true,
        }),
      ),
    );
    assert.equal(attempts.filter((r) => r.status === 200).length, 1);
    assert.equal(attempts.filter((r) => r.status === 409).length, 2);
    assert.equal(
      (
        await request(admin, "/supply/chain/" + work.id + "/manufacturing", {
          purchaseOrderId: po.id,
          technical: {},
        })
      ).status,
      409,
    );
    const sc = await ok(admin, "/quoting/versions/" + quoteId + "/documents", {
      kind: "contract",
      language: "both",
    });
    const pi = await ok(admin, "/quoting/versions/" + quoteId + "/documents", {
      kind: "pi",
      language: "both",
    });
    const contract = await ok(admin, "/quoting/documents/" + sc.id),
      invoice = await ok(admin, "/quoting/documents/" + pi.id);
    assert.ok((await PDFDocument.load(contract)).getPageCount() >= 3);
    assert.ok((await PDFDocument.load(invoice)).getPageCount() >= 3);
    const attachment = (
      await pool.query(
        "SELECT x.*,r.doc_no FROM technical_commercial_documents x JOIN crm_document_registry r ON r.id=x.registry_id WHERE x.document_id=$1",
        [sc.id],
      )
    ).rows[0];
    assert.equal(attachment.attachment_no, attachment.doc_no + "-A1");
    const oldDoc = randomUUID();
    await pool.query(
      "INSERT INTO quotation_documents(id,quote_id,kind,language,bytes_base64,sha256,created_by) VALUES($1,$2,'contract','en',$3,'OLD',$4)",
      [
        oldDoc,
        quoteId,
        Buffer.from(await signed.save()).toString("base64"),
        adminId,
      ],
    );
    assert.equal(
      (await request(admin, "/quoting/documents/" + oldDoc)).status,
      409,
    );
    const excel = await ok(
      factory,
      "/supply/manufacturing/" + mo.id + "/export/xlsx",
    );
    const ExcelJS = (await import("exceljs")).default,
      book = new ExcelJS.Workbook();
    await book.xlsx.load(excel);
    assert.equal(book.worksheets.reduce((n,s)=>n+s.getImages().length,0),1);
    const cells = book.worksheets
      .flatMap((s) => s.getSheetValues())
      .flat(5)
      .join(" ");
    assert.match(cells, /UPGRADED H3 FINAL/);
    assert.match(cells, /CE NFRC AAMA AS2047/);
    assert.doesNotMatch(
      cells,
      /SECRET|ISOLATED Private Buyer|buyer@private.invalid/,
    );
    const pdf = await ok(
      factory,
      "/supply/manufacturing/" + mo.id + "/export/pdf",
    );
    writeFileSync(path.join(out, kind + "-mo.xlsx"), excel);
    writeFileSync(path.join(out, kind + "-mo.pdf"), pdf);
    writeFileSync(path.join(out, kind + "-sc.pdf"), contract);
    if(ui){
      const page=await ui.browser.newPage();try{
        await page.goto(origin);await page.getByLabel('邮箱',{exact:true}).fill('factory@chain.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'退出',exact:true})).toBeVisible();
        await page.goto(origin+'/supply/manufacturing/'+mo.id);const download=page.waitForEvent('download');await page.getByRole('link',{name:'下载工厂版PDF',exact:true}).click();await(await download).saveAs(path.join(out,kind+'-ui-mo.pdf'));await expect(page.getByText(/SECRET|ISOLATED Private Buyer/)).toHaveCount(0);await page.screenshot({path:path.join(out,kind+'-ui-mo.png')});
      }finally{await page.close();}
    }
    const revisedImage=await ok(admin,`/supply/technical-drawings/${drawing.id}/redactions`,{baseVersion:1,rectangles:[{page:0,x:0,y:0,width:1,height:.35}],reason:'TEST new redaction resets review'});
    assert.equal((await request(factory,`/supply/manufacturing/${mo.id}/drawings/${redaction.id}/download`)).status,409);
    assert.equal((await request(factory,`/supply/manufacturing/${mo.id}/export/pdf`)).status,409);
    assert.equal((await request(admin,`/supply/manufacturing/${mo.id}/drawings/link`,{})).status,409);
    if(ui)await uiReview(ui.page,origin,drawing.id,revisedImage.id);else await ok(admin,`/supply/drawing-redactions/${revisedImage.id}/review`,{approved:true,note:'TEST reviewed revised copy',reviewedPages:[0],privacyRemoved:true,technicalPreserved:true});
    assert.equal((await request(factory,`/supply/manufacturing/${mo.id}/export/pdf`)).status,409,'new reviewed copy must explicitly link to MO');
    await ok(admin,`/supply/manufacturing/${mo.id}/drawings/link`,{});
    assert.equal((await request(factory,`/supply/manufacturing/${mo.id}/drawings/${redaction.id}/download`)).status,404,'old link stays invalid');
    await ok(factory,`/supply/manufacturing/${mo.id}/drawings/${revisedImage.id}/download`);
    assert.equal((await ok(admin,`/supply/technical-drawings/${drawing.id}/original`)).equals(originalBytes),true);
    if(kindIndex===0){
      const rejected=await ok(admin,`/supply/technical-drawings/${drawing.id}/redactions`,{baseVersion:2,rectangles:[],reason:'TEST unsafe copy must be rejected'});
      await ok(admin,`/supply/drawing-redactions/${rejected.id}/review`,{approved:false,note:'TEST customer identity remains visible',reviewedPages:[0],privacyRemoved:false,technicalPreserved:true});
      assert.equal((await request(factory,`/supply/manufacturing/${mo.id}/export/xlsx`)).status,409);
      assert.equal((await request(admin,`/supply/manufacturing/${mo.id}/drawings/link`,{})).status,409);
      assert.equal((await request(admin,`/supply/drawing-redactions/${rejected.id}/review`,{approved:true,note:'cannot overwrite rejection',reviewedPages:[0],privacyRemoved:true,technicalPreserved:true})).status,409);
      await assert.rejects(pool.query('UPDATE technical_drawing_redactions SET pages=$2 WHERE id=$1',[rejected.id,'[]']));
      passed('Rejected image blocks factory Excel and linkage; review and copy records cannot be overwritten');
    }
    passed(kind+': original internal, raster privacy, human review, immutable versions, MO linkage and stale download revocation');
    passed(
      kind +
        ": TC signature, G43 SC/PI attachment, G44 diff, G46 privacy, batch concurrency, real PDF/Excel and role isolation",
    );

    if (process.argv.includes("--ui") && kindIndex === 0) {
      // Browser plugin not available; use the existing isolated Playwright workflow.
      const { chromium, expect } = await import("@playwright/test"),
        browser = await chromium.launch({ channel: "msedge", headless: true });
      try {
        const page = await browser.newPage({
            viewport: { width: 1440, height: 1000 },
          }),
          errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(origin);
        await page
          .getByLabel("邮箱", { exact: true })
          .fill("admin@chain.invalid");
        await page.getByLabel("密码", { exact: true }).fill(password);
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "退出", exact: true }),
        ).toBeVisible();
        await page.goto(origin + "/technical");
        await expect(
          page.getByRole("heading", { name: "技术确认单 TC", exact: true }),
        ).toBeVisible();
        const saved = await ok(admin, "/supply/technical/" + tc.id);
        await page
          .getByRole("link", { name: saved.tc_no, exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: saved.tc_no + " V1", exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: path.join(out, "tc-desktop.png") });
        await page.getByRole("button", { name: "创建修订版本" }).click();
        await expect(
          page.getByRole("button", { name: "保存新版本（重新签字）" }),
        ).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(out, "tc-mobile.png") });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth,
          ),
          false,
        );
        await page.goto(origin + "/supply/manufacturing/" + mo.id);
        await expect(
          page.getByRole("heading", {
            name: "生产指令单 / Manufacturing Order",
            exact: true,
          }),
        ).toBeVisible();
        assert.deepEqual(errors, []);
        passed(
          "Desktop/mobile TC navigation and version editor, MO renderer, no overlay/overflow/page errors",
        );
      } finally {
        await browser.close();
      }
    }
    const before = (
      await pool.query(
        "SELECT technical_snapshot FROM crm_manufacturing_orders WHERE id=$1",
        [mo.id],
      )
    ).rows[0];
    const revision = await ok(admin, "/supply/technical", {
      ...body,
      previousId: tc.id,
      reason: "TEST changed technical version",
    });
    assert.equal(revision.version, 2);
    assert.equal(
      (await ok(admin, "/supply/manufacturing/" + mo.id)).changeRequired,
      true,
    );
    assert.equal(
      (await request(factory, "/supply/manufacturing/" + mo.id + "/export/pdf"))
        .status,
      409,
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT technical_snapshot FROM crm_manufacturing_orders WHERE id=$1",
          [mo.id],
        )
      ).rows[0],
      before,
    );
    assert.equal(
      (await request(admin, "/quoting/documents/" + sc.id)).status,
      409,
    );
    await assert.rejects(
      pool.query(
        "UPDATE technical_confirmation SET technical='{}' WHERE id=$1",
        [tc.id],
      ),
    );
    passed(
      kind +
        ": revision requires reconfirmation; historical MO immutable; stale exports blocked",
    );
  }
  if(ui)assert.deepEqual(ui.errors,[]);
  await local.createDatabase("technical_restore");
  const restored = database(
    `postgresql://postgres:${password}@127.0.0.1:55635/technical_restore`,
  );
  try {
    await migrate(restored);
    await restore(restored, await backup(pool));
    assert.equal(
      (
        await restored.query(
          "SELECT count(*)::int n FROM technical_confirmation",
        )
      ).rows[0].n,
      6,
    );
    for(const table of ['technical_drawings','technical_drawing_redactions','technical_drawing_reviews','technical_mo_drawings']){
      const column=table==='technical_drawing_reviews'?'redaction_id':'id';
      const digestRows=async(db:typeof pool)=>createHash('sha256').update(JSON.stringify((await db.query(`SELECT row_to_json(t) row FROM (SELECT * FROM ${table} ORDER BY ${column})t`)).rows)).digest('hex');
      assert.equal(await digestRows(restored),await digestRows(pool),'Restored drawings/reviews/links: '+table);
    }
    assert.equal(
      (
        await restored.query(
          "SELECT count(*)::int n FROM crm_manufacturing_orders",
        )
      ).rows[0].n,
      6,
    );
    passed(
      "Encrypted backup data model includes TC/MO versions, isolated restore preserves associations",
    );
  } finally {
    await restored.end();
  }
  writeFileSync(
    path.join(out, process.argv.includes('--ui')?'tests.json':'api-tests.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        environment: "isolated actual CRM PostgreSQL + Express",
        browserActions:process.argv.includes('--ui'),
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
} catch(e){
  console.error(e);
  if(ui){try{writeFileSync(path.join(out,'failure.txt'),await ui.page.locator('body').innerText({timeout:5000})+'\n'+JSON.stringify(ui.errors));await ui.page.screenshot({path:path.join(out,'failure.png'),timeout:5000});}catch{console.error('Failure capture unavailable; original error preserved');}}
  throw e;
} finally {
  if(ui)await ui.browser.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
  }
  await pool.end();
  if (started) await local.stop();
}
