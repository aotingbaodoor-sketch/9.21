import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cadWorker, analyzeCad } from "../server/cad-engine.ts";
const root =
  process.env.CAD_TEST_OUTPUT ||
  mkdtempSync(path.join(tmpdir(), "cad-release-"));
execFileSync(process.env.CAD_PYTHON || "python3", [
  path.resolve("tests/cad-fixtures.py"),
  root,
]);
test("原生PDF文字与矢量提取、有页码区域，非扫描页不伪称OCR", async () => {
  const r = await analyzeCad(
    readFileSync(path.join(root, "native-pdf.pdf")),
    "pdf",
  );
  assert.ok(r.evidence.length);
  assert.ok(r.vectors.length);
  assert.ok(
    r.evidence.every(
      (e: any) =>
        e.source === "pdf_text" && e.page === 1 && e.region.length === 4,
    ),
  );
  assert.equal(r.pages[0].needsOcr, false);
  assert.equal(r.units, 0);
});
test("工厂DXF重建：尺寸/可编辑实体保留、元数据清除，隐藏层与草稿拒绝", async () => {
  const r = await cadWorker("factory",{raw:readFileSync(path.join(root,"completed-test.dxf")).toString('base64'),stamp:['CUSTOMER CODE: A001261018001','TC TEST V1']});
  assert.ok(r.analysis.entities.some((e:any)=>e.text==='CUSTOMER CODE: A001261018001'));
  assert.equal(
    Buffer.from(r.dxf, "base64")
      .toString()
      .includes("PRIVATE_METADATA_MUST_BE_REMOVED"),
    false,
  );
  assert.deepEqual(
    r.analysis.entities
      .filter((e: any) => e.type === "DIMENSION")
      .map((e: any) => e.measurement),
    [1000, 2000],
  );
  await assert.rejects(
    cadWorker(
      "factory",
      readFileSync(path.join(root, "unsafe-hidden.dxf")).toString("base64"),
    ),
    /隐藏/,
  );
  const preview = await cadWorker("review_copy", r.dxf);
  assert.ok(
    Buffer.from(preview.dxf, "base64")
      .toString()
      .includes("NOT FOR PRODUCTION"),
  );
  await assert.rejects(cadWorker("factory", preview.dxf), /草稿/);
});
