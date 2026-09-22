import { chromium } from "playwright";
import { Decimal } from "decimal.js";
import type { QuoteRow } from "./types.ts";
import { specLabels } from "../../shared/quoting.ts";
import { escapeXml as e } from "../../shared/drawing.ts";
import { HttpError } from "../domain.ts";
import { round } from "./engine.ts";
export function quoteHtml(q: QuoteRow, kind: "quotation" | "pi" | "contract", language: "en" | "zh" | "both") {
  const c = q.snapshot, s = c.private.settings, f = q.input;
  const tr = (zh: string, en: string) => e(language === "zh" ? zh : language === "en" ? en : `${zh} / ${en}`);
  const money = (n: number | null) => n === null ? "PENDING" : `${f.currency} ${n.toFixed(2)}`;
  const title = kind === "quotation" ? tr("报价单", "QUOTATION") : kind === "pi" ? tr("形式发票", "PROFORMA INVOICE") : tr("销售合同", "SALES CONTRACT");
  const draft = kind === "contract" && (!s.contractApproved || (language !== "en" && !s.contractZh) || (language !== "zh" && !s.contractEn));
  const number = `QT-${q.id.slice(0, 8).toUpperCase()}-V${q.number}`, mode = f.freightDisplay, freight = c.freightTotal || 0;
  let allocated = 0;
  const rows = c.lines.map((l, i) => {
    const share = mode !== "allocated" ? 0 : i === c.lines.length - 1 ? round(new Decimal(freight).minus(allocated)) : round(new Decimal(freight).mul(c.productTotal ? l.productTotal / c.productTotal : 1 / c.lines.length));
    allocated = round(new Decimal(allocated).plus(share)); const amount = round(new Decimal(l.productTotal).plus(share));
    return `<tr><td>${i + 1}</td><td><b>${e(l.sku)}</b><br>${tr(l.nameZh, l.nameEn)}<br>${e(l.location)}</td><td>${l.widthMm} × ${l.heightMm} mm</td><td>${l.quantity}</td>${mode !== "total" ? `<td>${money(round(new Decimal(amount).div(l.quantity)))}</td><td>${money(amount)}</td>` : ""}</tr>`;
  }).join("");
  const details = c.lines.map((l, i) => `<section class="detail"><h2>${i + 1}. ${e(l.sku)} · ${tr(l.nameZh, l.nameEn)}</h2><p>${e(l.location)} · ${tr("数量", "Quantity")}: ${l.quantity}</p><div class="drawing">${l.svg}</div><table><tbody>${Object.entries(l.specs).filter(([, v]) => v).map(([k, v]) => `<tr><th>${e(specLabels[k] || k)}</th><td>${e(v)}</td></tr>`).join("")}<tr><th>${tr("选项", "Options")}</th><td>${e(l.options.join("; ")) || "—"}</td></tr><tr><th>${tr("特殊要求", "Special requirements")}</th><td>${e(l.special) || "—"}</td></tr><tr><th>${tr("包装估算", "Packing estimate")}</th><td>${l.packed.packages} ${tr("件", "packages")} · ${l.packed.widthMm} × ${l.packed.heightMm} × ${l.packed.depthMm} mm<br>${l.packed.cbm} CBM · ${l.packed.grossKg} kg · ${e(l.packed.type)}<br>${l.packed.fragile ? tr("易碎", "Fragile") : ""} · ${l.packed.fumigation ? tr("需熏蒸", "Fumigation required") : ""} · ${l.packed.stackable ? tr("可堆叠", "Stackable") : tr("不可堆叠", "Non-stackable")}</td></tr></tbody></table><p class="notice">${tr("报价确认示意图，非生产图纸；非标产品需另附审核技术图纸。", "Quotation confirmation drawing, NOT FOR PRODUCTION. Custom items require separately approved technical drawings.")}</p></section>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${number}</title><style>
  @page{size:A4;margin:16mm 14mm 18mm}*{box-sizing:border-box}body{font:11px/1.5 Arial,"Microsoft YaHei","Noto Sans CJK SC",sans-serif;color:#203a42;margin:0}header{display:flex;gap:15px;border-bottom:3px solid #26766c;padding-bottom:16px;margin-bottom:18px}header strong{font-size:25px;letter-spacing:2px}header p{margin:3px 0}header img{width:70px;height:65px;object-fit:contain}.doc{margin-left:auto;text-align:right}h1{font-size:20px;margin:0}h2{font-size:14px}.info{display:grid;grid-template-columns:1fr 1fr;gap:20px;background:#edf4f3;padding:14px;margin:14px 0}p{overflow-wrap:anywhere}.info p{margin:4px 0}table{width:100%;border-collapse:collapse}thead{display:table-header-group}th,td{padding:8px;border-bottom:1px solid #d7e0e3;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#edf3f3}tr{break-inside:avoid}.totals{margin:16px 0 16px auto;width:60%}.grand{font-size:15px;background:#e4f0ed;font-weight:bold}.terms{white-space:pre-wrap;overflow-wrap:anywhere}.notice{background:#fff6df;padding:10px}.detail{break-before:page}.drawing{max-width:410px;margin:auto}.drawing svg{width:100%;height:auto}.draft{color:#a2481b;border:2px solid;padding:10px;font-weight:bold}.signature{display:flex;gap:80px;margin-top:40px}.signature span{border-bottom:1px solid #555;flex:1;padding-bottom:30px}</style></head><body><header>${s.logo ? `<img src="${e(s.logo)}" alt="logo">` : ""}<div><strong>AUTINBERG</strong><p>${tr(s.companyZh, s.companyEn)}</p><small>${e(s.address)}<br>${e(s.contact)}</small></div><div class="doc"><h1>${title}</h1><p>${number}</p>${e(new Date(q.created_at).toISOString().slice(0, 10))}</div></header>${draft ? `<p class="draft">${tr("合同草稿 — 条款未批准，不可签署", "DRAFT CONTRACT — TERMS NOT APPROVED — NOT FOR SIGNATURE")}</p>` : ""}<div class="info"><div><b>${tr("客户", "CUSTOMER")}</b><p>${e(q.customer_snapshot.company)}<br>${e(q.customer_snapshot.contact)}<br>${e(q.customer_snapshot.email)}</p><p>${e(f.projectAddress)}</p></div><div><b>${tr("项目", "PROJECT")}</b><p>${e(f.name)}<br>${e(f.country)} · ${e(f.city)}<br>${e(f.incoterm)} ${e(f.namedPlace)} (Incoterms® 2020)<br>${tr("有效至", "Valid until")}: ${e(f.validUntil)}<br>${tr("目标发货", "Target dispatch")}: ${e(f.targetDate)}</p></div></div><table><thead><tr><th>#</th><th>${tr("产品", "Product")}</th><th>${tr("尺寸", "Dimensions")}</th><th>${tr("数量", "Qty")}</th>${mode !== "total" ? `<th>${tr("单价", "Unit price")}</th><th>${tr("金额", "Amount")}</th>` : ""}</tr></thead><tbody>${rows}${mode === "line" ? `<tr><td>—</td><td colspan="4">${tr("运费", "Freight")}</td><td>${money(freight)}</td></tr>` : ""}</tbody></table>${mode === "allocated" ? `<p>${tr("运费已分摊；展示单价有舍入，以行金额为准。", "Freight allocated; displayed unit prices are rounded. Line amounts prevail.")}</p>` : ""}<table class="totals"><tbody>${mode !== "total" ? `<tr><td>${tr("产品小计", "Products subtotal")}</td><td>${money(round(new Decimal(c.productTotal).plus(mode === "allocated" ? freight : 0)))}</td></tr><tr><td>${tr("包装费", "Packing")}</td><td>${money(c.packingTotal)}</td></tr>${mode === "separate" ? `<tr><td>${tr("运费", "Freight")}</td><td>${money(freight)}</td></tr>` : ""}` : ""}<tr class="grand"><td>${tr("总计", "TOTAL")}</td><td>${money(c.total)}</td></tr></tbody></table><p>${tr("包装合计", "Packing total")}: ${c.packages} · ${c.cbm} CBM · ${c.netKg} kg ${tr("净重", "net")} / ${c.grossKg} kg ${tr("毛重", "gross")}</p><p>${f.incoterm === "EXW" ? tr("买方负责提货及运输，运费不包含。", "Buyer arranges collection and transport; freight excluded.") : `${e(f.originPort)} → ${e(f.destinationPort)} · ${e(f.freightMode)}<br>${e(f.deliveryAddress)}`}</p>${s.showPackingNotice ? `<p class="notice">${tr("包装尺寸、重量、运费为估算，出货前须实测复核。柜型建议不代替装柜方案。", "Packing, weights and freight are estimates, subject to final measurement. Container suggestions are not a loading plan.")}</p>` : ""}<div class="terms"><b>${tr("付款及商务条款", "PAYMENT AND COMMERCIAL TERMS")}</b><p>${e(f.paymentTerms)}</p>${language !== "en" ? `<p>${e(s.termsZh)}</p>` : ""}${language !== "zh" ? `<p>${e(s.termsEn)}</p>` : ""}<p>${e(f.notes)}</p>${kind !== "quotation" ? `<b>${tr("收款信息", "BANK DETAILS")}</b><p>${e(s.bankDetails) || tr("尚未提供 — 不可据此付款", "NOT PROVIDED — DO NOT PAY AGAINST THIS DOCUMENT")}</p>` : ""}${kind === "pi" ? `<p>${tr("形式发票并非收款证明或税务发票。", "Proforma invoice only; not a receipt or tax invoice.")}</p>` : ""}${kind === "contract" ? `${language !== "en" ? `<p>${e(s.contractZh)}</p>` : ""}${language !== "zh" ? `<p>${e(s.contractEn)}</p>` : ""}<div class="signature"><span>${tr("卖方签章", "Seller signature")}</span><span>${tr("买方签章", "Buyer signature")}</span></div>` : ""}</div>${details}</body></html>`;
}
let active = 0;
export async function renderQuotePdf(q: QuoteRow, kind: "quotation" | "pi" | "contract", language: "en" | "zh" | "both") {
  if (active >= 2) throw new HttpError(503, "PDF生成繁忙，请稍后再试"); active++;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}), timeout: 30000 });
    const ctx = await browser.newContext({ javaScriptEnabled: false }); await ctx.route("**/*", r => r.abort());
    const page = await ctx.newPage(); await page.setContent(quoteHtml(q, kind, language), { waitUntil: "load", timeout: 15000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([page.pdf({ format: "A4", printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: '<div style="width:100%;font:9px Arial;text-align:center;color:#667">AUTINBERG · <span class="pageNumber"></span> / <span class="totalPages"></span></div>' }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(503, "PDF生成超时，请减少产品数量后重试")), 30000); })]); } finally { clearTimeout(timer); }
  } finally {
    if (browser) {
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          browser.close(),
          new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 5000); }),
        ]);
      } finally { clearTimeout(closeTimer); }
    }
    active--;
  }
}
