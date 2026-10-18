import ExcelJS from "exceljs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { escapeXml as escape } from "../../shared/drawing.ts";
import { HttpError } from "../domain.ts";
import {TC_FIELDS,TC_GROUPS,PRODUCTION_FIELDS} from '../../shared/technical.ts';
import {rasterPdf,type RasterPage} from '../drawing-raster.ts';
export function technicalHtml(t:any,original?:Record<string,Record<string,string>>) {
  const e=(v:unknown)=>escape(String(v??''));
  return t.items.map((i:any)=>`<h2>${e(i.lineKey)} · ${e(i.kind)} · ${e(i.widthMm)} × ${e(i.heightMm)} mm · ${e(i.quantity)}</h2>${TC_GROUPS.map(g=>`<h3>${e(g.title)}</h3><table>${original?'<thead><tr><th>项目 / Item</th><td>客户原始需求 / Original</td><td>我方确认配置 / Confirmed</td></tr></thead>':''}<tbody>${g.keys.map(k=>`<tr><th>${e(TC_FIELDS[k])}</th>${original?`<td>${e(original[i.lineKey]?.[k])||'—'}</td>`:''}<td>${e(i.fields[k])||'—'}</td></tr>`).join('')}</tbody></table>`).join('')}`).join('');
}
export type ManufacturingView = {
  docNo: string;
  customerCode: string;
  woNo: string;
  poNo: string;
  issuedAt: string;
  technical: Record<string, any>;
  warranty: { part: string; months?: number; days?: number }[];
  drawingPages?:RasterPage[];
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
  if(d.technical.tcTechnical)return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:14mm}body{font:12px/1.5 Arial,"Microsoft YaHei","Noto Sans CJK SC"}table{width:100%;border-collapse:collapse;margin:12px 0;table-layout:fixed}th,td{border:1px solid #ccc;padding:6px;overflow-wrap:anywhere}th{width:44%;background:#f4f0e6}tr{break-inside:avoid}h2{break-after:avoid}</style></head><body><h1>AUTINBERG 生产指令单 / MO</h1><p>${e(d.docNo)} · Customer ID ${e(d.customerCode)}</p><p>WO ${e(d.woNo)} · PO ${e(d.poNo)}</p><p>源TC ${e(d.technical.sourceTcNo)} V${e(d.technical.sourceTcVersion)}（不附TC原件）</p>${technicalHtml(d.technical.tcTechnical)}<h2>生产线需求 / Production</h2><table>${Object.entries(PRODUCTION_FIELDS).map(([k,v])=>`<tr><th>${e(v)}</th><td>${e(d.technical.production[k])}</td></tr>`).join('')}</table><p>甲方确认 / Authorized confirmation: ${e(d.technical.partyA.name)} · ${e(d.technical.partyA.confirmedAt)}</p><p>工厂接收签认 / Factory signature: __________ Date: __________</p></body></html>`;
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
  if(d.technical.tcTechnical){
    // Preserve the existing template cover. A typed appendix contains every retained technical field.
    const detail=book.addWorksheet('TC技术及生产段');detail.columns=[{width:45},{width:75}];
    detail.addRow(['MO',d.docNo]);detail.addRow(['客户编号 / Customer ID',d.customerCode]);detail.addRow(['源TC / Source TC',`${d.technical.sourceTcNo} V${d.technical.sourceTcVersion}`]);
    for(const i of d.technical.tcTechnical.items){detail.addRow(['产品行 / Line',i.lineKey]);detail.addRow(['类型 / Type',i.kind]);detail.addRow(['数量 / Quantity',i.quantity]);detail.addRow(['宽 mm',i.widthMm]);detail.addRow(['高 mm',i.heightMm]);for(const [k,label] of Object.entries(TC_FIELDS))detail.addRow([label,i.fields[k]||'—']);}
    for(const [k,label] of Object.entries(PRODUCTION_FIELDS))detail.addRow([label,d.technical.production[k]]);
    detail.addRow(['甲方确认',d.technical.partyA.name]);detail.addRow(['确认时间',d.technical.partyA.confirmedAt]);
    detail.eachRow(r=>{r.alignment={vertical:'top',wrapText:true};r.font={name:'Microsoft YaHei',size:11};r.height=Math.max(24,Math.ceil(String(r.getCell(2).value??'').length/40)*18);});
    detail.pageSetup={paperSize:9,orientation:'portrait',fitToPage:true,fitToWidth:1,fitToHeight:0};
  }
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
  for(const [index,p] of (d.drawingPages??[]).entries()){
    const tab=book.addWorksheet(`已审生产图纸${index+1}`);const id=book.addImage({base64:p.png,extension:'png'});
    tab.addImage(id,{tl:{col:0,row:0},ext:{width:Math.min(p.width,1200),height:Math.round(p.height*Math.min(p.width,1200)/p.width)}});
    tab.pageSetup={paperSize:9,orientation:p.width>p.height?'landscape':'portrait',fitToPage:true,fitToWidth:1,fitToHeight:1};
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
let active = 0;
export async function manufacturingPdf(d: ManufacturingView) {
  return rasterPdf(d.drawingPages??[],await renderHtmlPdf(manufacturingHtml(d)));
}
export async function renderHtmlPdf(html:string) {
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
    await page.setContent(html, {
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
