import ExcelJS from "exceljs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { escapeXml as escape } from "../../shared/drawing.ts";
import { HttpError } from "../domain.ts";
export type ManufacturingView = {
  docNo: string;
  customerCode: string;
  woNo: string;
  poNo: string;
  issuedAt: string;
  technical: Record<string, any>;
  warranty: { part: string; months?: number; days?: number }[];
};
const labels: Record<string, string> = {
  profile: "型材 / Profile",
  glass: "玻璃 / Glass",
  hardware: "五金 / Hardware",
  finish: "表面处理 / Finish",
  sampleReference: "封样依据 / Sample",
  packing: "包装要求 / Packing",
  requiredDate: "要求完工日 / Required date",
};
export function manufacturingHtml(d: ManufacturingView) {
  const e = (v: unknown) => escape(String(v ?? ""));
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${e(d.docNo)}</title><style>@page{size:A4;margin:14mm}body{font:12px/1.5 Arial,"Microsoft YaHei","Noto Sans CJK SC";color:#222}h1{font-size:22px}h2{font-size:16px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #aaa;padding:7px;overflow-wrap:anywhere}tr{break-inside:avoid}th{background:#f2ede3}.notice{padding:12px;background:#f7f5ef}p{overflow-wrap:anywhere}</style></head><body><h1>AUTINBERG · 生产指令单 / Manufacturing Order</h1><p>MO: ${e(d.docNo)} · ${e(new Date(d.issuedAt).toISOString().slice(0, 10))}</p><p>Customer ID 客户编号: ${e(d.customerCode)}</p><p>WO: ${e(d.woNo)} · PO: ${e(d.poNo)}</p><table><thead><tr><th>产品行 / Line</th><th>尺寸 mm</th><th>数量 / Qty</th></tr></thead><tbody>${d.technical.items.map((i: any) => `<tr><td>${e(i.line)}</td><td>${e(i.widthMm)} × ${e(i.heightMm)}</td><td>${e(i.quantity)}</td></tr>`).join("")}</tbody></table><table><tbody>${Object.entries(
    labels,
  )
    .map(
      ([key, label]) =>
        `<tr><th>${label}</th><td>${e(d.technical[key])}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table><h2>对供应商保质期 / Supplier warranty</h2><p>自实际交付之日起 / From actual delivery date</p>${d.warranty.map((w) => `<p>${e(w.part)}: ${w.months ? e(w.months) + "个月 / months" : e(w.days) + "日内 / days"}</p>`).join("")}<p>严格按本指令及双方封样生产；用料和工艺变更须书面确认并重新签发。旧版不可覆盖。</p><p>每周五17:00反馈进度；影响交期的异常4小时内书面通报。</p><p class="notice">工厂专用版本。仅以13位客户编号标识。Internal work orders must not be substituted for this factory document.</p><p>甲方授权签认 / Authorized signature: __________　日期 / Date: __________</p><p>工厂接收签认 / Factory acceptance: __________　日期 / Date: __________</p></body></html>`;
}
export async function manufacturingExcel(d: ManufacturingView) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(
    fileURLToPath(new URL("../assets/forms/mo-v21.xlsx", import.meta.url)),
  );
  const sheet = book.worksheets[0],
    items = d.technical.items;
  if (items.length > 7)
    throw new HttpError(
      422,
      "原始MO模板每页7行，本单超过模板容量；请下载包含全部行的PDF，禁止静默截断",
    );
  sheet.getCell("C4").value = d.docNo;
  sheet.getCell("I4").value = new Date(d.issuedAt).toISOString().slice(0, 10);
  sheet.getCell("C5").value = d.poNo;
  sheet.getCell("I5").value = d.woNo;
  sheet.getCell("C6").value = d.customerCode;
  sheet.getCell("I7").value = d.technical.requiredDate;
  [
    "profile",
    "glass",
    "hardware",
    "finish",
    "sampleReference",
    "packing",
  ].forEach(
    (key, i) => (sheet.getCell("C" + (21 + i)).value = d.technical[key]),
  );
  items.forEach((i: any, index: number) => {
    const row = 13 + index;
    sheet.getCell("A" + row).value = index + 1;
    sheet.getCell("B" + row).value = i.line;
    sheet.getCell("C" + row).value = [
      d.technical.profile,
      d.technical.glass,
      d.technical.hardware,
      d.technical.finish,
    ].join(" / ");
    sheet.getCell("D" + row).value = i.widthMm + " × " + i.heightMm;
    sheet.getCell("E" + row).value = i.quantity;
    sheet.getCell("F" + row).value = "";
  });
  // Remove template example IDs; business values always come from the immutable record.
  sheet.getCell("A2").value =
    "工厂专用 · 生产指令单 / Manufacturing Order · 本单是PO技术附件 · 无MO不得开工";
  sheet.getCell("C9").value =
    "本单仅以13位客户编号标识。所有资料保密，不得转用或用于直接联系。";
  return Buffer.from(await book.xlsx.writeBuffer());
}
let active = 0;
export async function manufacturingPdf(d: ManufacturingView) {
  if (active >= 2) throw new HttpError(503, "PDF生成繁忙，请稍后重试");
  active++;
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.platform === "win32" ? { channel: "msedge" } : {}),
      timeout: 30000,
    });
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route("**/*", (r) => r.abort());
    const page = await context.newPage();
    await page.setContent(manufacturingHtml(d), {
      waitUntil: "load",
      timeout: 15000,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        page.pdf({ format: "A4", printBackground: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new HttpError(503, "PDF生成超时，请稍后重试")),
            30000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    active--;
    if (browser) {
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          browser.close(),
          new Promise<void>((resolve) => {
            closeTimer = setTimeout(resolve, 5000);
          }),
        ]);
      } finally {
        clearTimeout(closeTimer);
      }
    }
  }
}
