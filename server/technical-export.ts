import { PDFDocument } from "pdf-lib";
import { escapeXml as e } from "../shared/drawing.ts";
import { technicalHtml, renderHtmlPdf } from "./supply/manufacturing-export.ts";
export async function attachSignedTc(
  base: Buffer,
  t: any,
  signature: { mime: string; bytes_base64: string },
  attachmentNo: string,
  customerCode: string,
  company: string,
) {
  const appendix = await renderHtmlPdf(
    `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:14mm}body{font:12px/1.5 Arial,"Microsoft YaHei","Noto Sans CJK SC"}table{width:100%;border-collapse:collapse;table-layout:fixed}td,th{border:1px solid #aaa;padding:6px;overflow-wrap:anywhere}th{width:44%}tr{break-inside:avoid}h2{break-after:avoid}</style></head><body><h1>技术确认附件 / Technical Confirmation</h1><p>${e(attachmentNo)}</p><p>${e(t.tc_no)} V${t.version} · ${e(customerCode)} · ${e(company)}</p><p>客户签字 / Customer signatory: ${e(t.signer_name)} · ${e(String(t.signed_on).slice(0, 10))}</p>${technicalHtml(t.technical,t.business.originalRequirements)}<h2>已核实的客户签字凭证见后附页 / Verified signed evidence follows</h2></body></html>`,
  );
  const output = await PDFDocument.load(base);
  for (const bytes of [
    appendix,
    ...(signature.mime === "application/pdf"
      ? [Buffer.from(signature.bytes_base64, "base64")]
      : []),
  ]) {
    const input = await PDFDocument.load(bytes);
    for (const p of await output.copyPages(input, input.getPageIndices()))
      output.addPage(p);
  }
  if (signature.mime !== "application/pdf") {
    const bytes = Buffer.from(signature.bytes_base64, "base64"),
      img =
        signature.mime === "image/png"
          ? await output.embedPng(bytes)
          : await output.embedJpg(bytes);
    const p = output.addPage([595, 842]),
      size = img.scaleToFit(535, 782);
    p.drawImage(img, {
      x: 30,
      y: 842 - 30 - size.height,
      width: size.width,
      height: size.height,
    });
  }
  return Buffer.from(await output.save());
}
