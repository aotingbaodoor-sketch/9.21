// Read-only real-file inspection. No CRM writes, no external drawing upload, no invented confirmation.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { analyzeCad } from "../server/cad-engine.ts";
const [out, ...files] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const summary = [];
for (const file of files) {
  const bytes = readFileSync(file),
    format = path.extname(file).slice(1).toLowerCase();
  try {
    const result = await analyzeCad(bytes, format);
    writeFileSync(
      path.join(out, `private-${summary.length}-analysis.json`),
      JSON.stringify(result),
    );
    if (result.pages?.[0])
      writeFileSync(
        path.join(out, `private-${summary.length}-page1.png`),
        Buffer.from(result.pages[0].png, "base64"),
      );
    const entry = {
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      status: result.status,
      units: result.units,
      pages: result.pages?.length,
      nativeText: result.evidence?.filter((e: any) => e.source === "pdf_text")
        .length,
      vectors: result.vectors?.length,
      entities: result.entities?.length,
      warnings: result.warnings,
    };
    summary.push(entry);
    console.log(JSON.stringify({ ...entry, file: path.basename(file) }));
  } catch (e) {
    summary.push({ file, error: e instanceof Error ? e.message : "failed" });
    console.log(JSON.stringify(summary.at(-1)));
  }
}
writeFileSync(
  path.join(out, "real-file-checks.json"),
  JSON.stringify(summary, null, 2),
);
