import { test } from "node:test";
import assert from "node:assert/strict";
import { cadWorker } from "../server/cad-engine.ts";
import { cadParameters, cadConflicts, cadSvg } from "../shared/cad.ts";
import { tcFieldsSchema } from "../shared/technical.ts";
import { mkdirSync, writeFileSync } from "node:fs";
const out = process.env.CAD_TEST_OUTPUT;
const items = ["door", "window", "wall_panel"].map((kind, n) => ({
  kind,
  lineKey: "TEST-" + n,
  widthMm: 1000 + n * 200,
  heightMm: 2000,
  quantity: n + 1,
  fields: tcFieldsSchema.parse({
    material: "TEST aluminum",
    profile: "TEST only",
    finalHardware: "TEST final hardware",
  }),
}));
const details = Object.fromEntries(
  items.map((i) => [
    i.lineKey,
    {
      openingWidthMm: null,
      openingHeightMm: null,
      leafWidthMm: null,
      leafHeightMm: null,
      depthMm: 80,
      viewDirection: "TEST internal looking out",
      location: "ISOLATED",
      evidence: "ISOLATED fixture",
    },
  ]),
);
test("真实DXF门窗护墙草稿具有可编辑实体、原生尺寸、mm及版本", async () => {
  const result = await cadWorker("generate", {
    items,
    details,
    drawingNo: "ISOLATED-TEST-CAD",
    version: 1,
    date: "2026-10-18",
    tcNo: "TEST-TC",
    tcVersion: 1,
    customerCode: "A001261018001",
  });
  assert.equal(result.analysis.units, 4);
  assert.ok(
    result.analysis.entities.filter((e: any) => e.type === "DIMENSION")
      .length === 6,
  );
  assert.ok(result.analysis.entities.some((e: any) => e.type === "LWPOLYLINE"));
  assert.ok(
    result.analysis.entities.some((e: any) =>
      e.text?.includes("NOT FOR PRODUCTION"),
    ),
  );
  const repeat = await cadWorker("analyze", result.dxf);
  assert.equal(repeat.entities.length, result.analysis.entities.length);
  for (const i of items)
    assert.ok(repeat.entities.some((e: any) => e.measurement === i.widthMm));
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(out + "/sample-draft.dxf", Buffer.from(result.dxf, "base64"));
    writeFileSync(
      out + "/sample-draft.svg",
      cadSvg(result.analysis.primitives),
    );
    writeFileSync(
      out + "/sample-analysis.json",
      JSON.stringify(result.analysis, null, 2),
    );
  }
});
test("未知单位/未确认比例/尺寸缺失阻止生成；TC差异及数量必须明确", () => {
  const valid = {
    units: "mm",
    scaleConfirmed: true,
    technical: { items },
    details,
    engineeringBasis: "",
    notes: "",
  };
  assert.ok(cadParameters.safeParse(valid).success);
  assert.equal(cadParameters.safeParse({ ...valid, units: "" }).success, false);
  assert.equal(
    cadParameters.safeParse({ ...valid, scaleConfirmed: false }).success,
    false,
  );
  assert.equal(
    cadParameters.safeParse({
      ...valid,
      technical: { items: [{ ...items[0], widthMm: null }] },
    }).success,
    false,
  );
  assert.equal(
    cadConflicts(
      { items } as any,
      { items: [{ ...items[0], quantity: 99, widthMm: 1 }] } as any,
    ).length,
    3,
  );
});
