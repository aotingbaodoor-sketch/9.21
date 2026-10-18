// Isolated database/API checks; never uses production credentials or real customers.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { localPostgres } from "../scripts/postgres-runtime.ts";
import { database, migrate } from "../server/db.ts";
import { createApp } from "../server/app.ts";
import { hashPassword } from "../server/domain.ts";
import { tcFieldsSchema, tcBusinessSchema } from "../shared/technical.ts";
import { requireCadProduction } from "../server/cad.ts";
import type { Server } from "node:http";
const root = mkdtempSync(path.join(os.tmpdir(), "autinberg-cad-test-")),
  password = randomBytes(32).toString("hex"),
  origin = "http://127.0.0.1:4638";
const output = process.env.CAD_TEST_OUTPUT || path.join(root, "evidence");
mkdirSync(output, { recursive: true });
const local = await localPostgres({
  databaseDir: path.join(root, "pg"),
  port: 55638,
  user: "postgres",
  password,
  persistent: true,
  fastIsolatedInit: true,
  onLog: () => {},
  onError: () => {},
});
const pool = database(
  `postgresql://postgres:${password}@127.0.0.1:55638/cad_test`,
);
let server: Server | undefined,
  started = false;
const results: string[] = [];
const pass = (s: string) => {
  results.push(s);
  console.log("PASS " + s);
};
async function req(
  actor: any,
  url: string,
  body?: unknown,
  key: string = randomUUID(),
) {
  const r = await fetch(origin + "/api" + url, {
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
    status: r.status,
    data: r.headers.get("content-type")?.includes("application/json")
      ? await r.json()
      : Buffer.from(await r.arrayBuffer()),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
async function ok(actor: any, url: string, body?: unknown, key?: string) {
  const r = await req(actor, url, body, key);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
try {
  await local.initialise();
  await local.start();
  started = true;
  await local.createDatabase("cad_test");
  await migrate(pool);
  await migrate(pool);
  pass("030增量迁移及重复迁移");
  const ids = {
    admin: randomUUID(),
    sales: randomUUID(),
    other: randomUUID(),
    factory: randomUUID(),
  };
  const hash = await hashPassword(password);
  for (const [name, id] of Object.entries(ids))
    await pool.query(
      "INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)",
      [
        id,
        "ISOLATED " + name,
        name + "@cad.invalid",
        hash,
        name === "other" ? "sales" : name,
      ],
    );
  const web = path.join(root, "web");
  mkdirSync(web);
  await cp(path.resolve("dist"), path.join(web, "dist"), { recursive: true });
  process.chdir(web);
  server = createApp(pool, { origin, serveStatic: true }).listen(
    4638,
    "127.0.0.1",
  );
  await new Promise<void>((r) => server!.once("listening", r));
  const actors: any = {};
  for (const name of Object.keys(ids)) {
    const r = await req(null, "/auth/login", {
      email: name + "@cad.invalid",
      password,
    });
    assert.equal(r.status, 200);
    actors[name] = { cookie: r.cookie, csrf: r.data.csrf };
  }
  const admin = actors.admin;
  await ok(admin, "/customer-identities/sources/initialize", {});
  const partners = await ok(admin, "/customer-identities/sources");
  for (const kind of ["door", "window", "wall_panel"]) {
    const c = await ok(admin, "/customers", {
      company: "ISOLATED PRIVATE " + kind,
    });
    await pool.query("UPDATE customers SET owner_id=$2 WHERE id=$1", [
      c.id,
      ids.sales,
    ]);
    await ok(admin, "/customers/" + c.id + "/identity", {
      partnerId: partners[0].id,
      firstContactDate: "2026-10-18",
      confirmHistoricalInfoOnly: false,
    });
    const project = await ok(admin, "/quoting/projects", {
      customerId: c.id,
      name: "ISOLATED CAD " + kind,
    });
    const technical = {
      items: [
        {
          kind,
          lineKey: "TEST-01",
          widthMm: 1000,
          heightMm: 2000,
          quantity: 2,
          fields: tcFieldsSchema.parse({
            material: "TEST aluminium",
            finalHardware: "TEST upgraded hardware",
          }),
        },
      ],
    };
    const t = await ok(admin, "/supply/technical", {
      projectId: project.id,
      technical,
      business: tcBusinessSchema.parse({}),
      reason: "ISOLATED CAD fixture",
    });
    const bytes = readFileSync(path.join(output, "sample-draft.dxf")).toString(
      "base64",
    );
    const body = {
        name: "ISOLATED-input.dxf",
        data: bytes,
        enableDrafting: true,
      },
      source = await ok(
        admin,
        `/supply/cad/projects/${project.id}/sources`,
        body,
      );
    assert.equal(
      (await ok(admin, `/supply/cad/projects/${project.id}/sources`, body)).id,
      source.id,
    );
    pass(kind + ": 同文件复用，不重复保存");
    const analysis = await ok(
      admin,
      `/supply/cad/sources/${source.id}/analyze`,
      {},
    );
    assert.equal(analysis.status, "analyzed");
    assert.equal(
      (await ok(admin, `/supply/cad/sources/${source.id}/analyze`, {})).cached,
      true,
    );
    const parameters = {
      units: "mm",
      scaleConfirmed: true,
      technical,
      details: {
        "TEST-01": {
          openingWidthMm: 1020,
          openingHeightMm: 2020,
          leafWidthMm: null,
          leafHeightMm: null,
          depthMm: 80,
          viewDirection: "TEST inside looking out",
          location: "TEST",
          evidence: "DXF entities / ISOLATED fixture",
        },
      },
      engineeringBasis: "TEST only; company sections pending",
      notes: "ISOLATED",
    };
    const input = {
        sourceId: source.id,
        tcId: t.id,
        baseVersion: 0,
        parameters,
        reason: "ISOLATED first draft",
      },
      key = randomUUID();
    assert.equal(
      (
        await req(admin, `/supply/cad/projects/${project.id}/versions`, {
          ...input,
          parameters: { ...parameters, units: "" },
        })
      ).status,
      400,
    );
    const v = await ok(
      admin,
      `/supply/cad/projects/${project.id}/versions`,
      input,
      key,
    );
    assert.equal(
      (
        await ok(
          admin,
          `/supply/cad/projects/${project.id}/versions`,
          input,
          key,
        )
      ).id,
      v.id,
    );
    assert.equal(
      (await req(actors.other, `/supply/cad/versions/${v.id}/export/dxf`))
        .status,
      404,
    );
    assert.equal(
      (await req(actors.factory, `/supply/cad/versions/${v.id}/export/dxf`))
        .status,
      403,
    );
    assert.equal(
      (
        await req(actors.sales, `/supply/cad/versions/${v.id}/review`, {
          decision: "approved_draft",
          note: "no",
          dimensionsChecked: true,
          privacyChecked: true,
        })
      ).status,
      403,
    );
    await ok(admin, `/supply/cad/versions/${v.id}/review`, {
      decision: "approved_draft",
      note: "ISOLATED reviewed, not production",
      dimensionsChecked: true,
      privacyChecked: true,
    });
    const pdf = await ok(admin, `/supply/cad/versions/${v.id}/export/pdf`);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    writeFileSync(path.join(output, kind + "-draft.pdf"), pdf);
    const dxf = await ok(admin, `/supply/cad/versions/${v.id}/export/dxf`);
    assert.equal(dxf.toString().includes("ISOLATED PRIVATE"), false);
    writeFileSync(path.join(output, kind + "-draft.dxf"), dxf);
    await assert.rejects(requireCadProduction(pool, project.id), /公司批准/);
    pass(kind + ": 上传分析→参数→DXF/PDF→草稿审核、幂等、权限及投产阻止");
    if (kind === "door") {
      const changed = structuredClone(input);
      changed.parameters.technical.items[0].widthMm = 1100;
      changed.baseVersion = 1;
      const v2 = await ok(
        admin,
        `/supply/cad/projects/${project.id}/versions`,
        changed,
      );
      assert.ok(
        (await ok(admin, `/supply/cad/versions/${v2.id}`)).issues.length,
      );
      assert.equal(
        (
          await req(admin, `/supply/cad/versions/${v2.id}/review`, {
            decision: "approved_draft",
            note: "conflict",
            dimensionsChecked: true,
            privacyChecked: true,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await req(admin, `/supply/cad/versions/${v.id}/review`, {
            decision: "approved_draft",
            note: "old",
            dimensionsChecked: true,
            privacyChecked: true,
          })
        ).status,
        409,
      );
      await ok(admin, `/supply/cad/versions/${v2.id}/review`, {
        decision: "withdrawn",
        note: "withdraw test",
        dimensionsChecked: false,
        privacyChecked: false,
      });
      assert.equal(
        (await req(admin, `/supply/cad/versions/${v2.id}/export/dxf`)).status,
        409,
      );
      pass("TC尺寸差异、新版作废旧审核资格、撤回停止下载");
      const fail = await ok(
        admin,
        `/supply/cad/projects/${project.id}/sources`,
        {
          name: "broken.dxf",
          data: Buffer.from("NOT DXF").toString("base64"),
          enableDrafting: true,
        },
      );
      assert.equal(
        (await ok(admin, `/supply/cad/sources/${fail.id}/analyze`, {})).status,
        "failed",
      );
      assert.equal(
        (await ok(admin, `/supply/cad/sources/${fail.id}/download`)).toString(),
        "NOT DXF",
      );
      pass("失败保留原件、错误记录及重试入口");
    }
  }
  writeFileSync(
    path.join(output, "api-results.json"),
    JSON.stringify(
      { results, productionMutations: 0, scope: "isolated" },
      null,
      2,
    ),
  );
  if (process.argv.includes("--hold")) {
    console.log("ISOLATED_UI_READY " + origin);
    writeFileSync(
      path.join(root, "ui-access.json"),
      JSON.stringify({ email: "admin@cad.invalid", password }),
    );
    console.log("UI_ACCESS_FILE " + path.join(root, "ui-access.json"));
    await new Promise<void>((resolve) => process.once("SIGINT", resolve));
  }
} finally {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await pool.end();
  if (started) await local.stop();
}
