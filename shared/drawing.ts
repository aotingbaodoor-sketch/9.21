import type { Product, QuoteLine } from "./quoting.ts";
export const escapeXml = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function drawProduct(line: QuoteLine, product: Pick<Product, "drawing" | "sku">, widthMm: number, heightMm: number) {
  const scale = Math.min(370 / widthMm, 245 / heightMm), w = widthMm * scale, h = heightMm * scale, x = (500 - w) / 2, y = 48 + (245 - h) / 2;
  const txt = (x: number, y: number, t: string, size = 12) => `<text x="${x}" y="${y}" text-anchor="middle" font-size="${size}">${escapeXml(t)}</text>`;
  const path = (d: string, dashed = false) => `<path d="${d}" fill="none" stroke="#365e6b" stroke-width="1.5" ${dashed ? 'stroke-dasharray="5 3"' : ""}/>`;
  let shapes = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#eef7fa" stroke="#29414b" stroke-width="4"/>`;
  if (product.drawing === "custom" || line.nonstandard) shapes = txt(250, 160, "CUSTOM — TECHNICAL REVIEW REQUIRED", 14);
  else for (let row = 0; row < line.rows; row++) for (let col = 0; col < line.columns; col++) {
    const pw = w / line.columns, ph = h / line.rows, px = x + col * pw, py = y + row * ph, panel = line.panels[row * line.columns + col];
    shapes += `<rect x="${px + 3}" y="${py + 3}" width="${Math.max(1, pw - 6)}" height="${Math.max(1, ph - 6)}" fill="none" stroke="#54737d"/>`;
    if (panel === "fixed" || product.drawing === "fixed") shapes += txt(px + pw / 2, py + ph / 2, "FIXED", Math.min(11, pw / 5));
    else if (product.drawing === "sliding") {
      const end = px + pw * (panel === "left" ? .18 : .82), start = px + pw * (panel === "left" ? .82 : .18), sign = panel === "left" ? 1 : -1;
      shapes += path(`M ${start} ${py + ph / 2} L ${end} ${py + ph / 2} m ${sign * 8} -6 l ${-sign * 8} 6 l ${sign * 8} 6`);
    } else if (product.drawing === "folding") shapes += path(`M ${px + 8} ${py + ph * .7} L ${px + pw / 2} ${py + ph * .4} L ${px + pw - 8} ${py + ph * .7}`, line.swing === "out");
    else if (product.drawing === "pivot") shapes += path(`M ${px + pw / 2} ${py + 8} L ${px + pw / 2} ${py + ph - 8} M ${px + 8} ${py + ph / 2} L ${px + pw - 8} ${py + ph / 2}`, line.swing === "out");
    else { const hinge = panel === "left" ? px + 8 : px + pw - 8, tip = panel === "left" ? px + pw - 8 : px + 8; shapes += path(`M ${hinge} ${py + 8} L ${tip} ${py + ph / 2} L ${hinge} ${py + ph - 8}`, line.swing === "out"); }
  }
  shapes += path(`M ${x} ${y - 10} V ${y - 22} H ${x + w} V ${y - 10}`) + txt(250, y - 28, `${widthMm} mm`);
  shapes += path(`M ${x + w + 10} ${y} H ${x + w + 22} V ${y + h} H ${x + w + 10}`);
  shapes += `<text transform="translate(${x + w + 38} ${y + h / 2}) rotate(90)" text-anchor="middle" font-size="12">${heightMm} mm</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 365" role="img" aria-label="${escapeXml(product.sku)} ${widthMm} × ${heightMm} mm"><rect width="500" height="365" fill="white"/><g font-family="Arial, Microsoft YaHei, sans-serif" fill="#29414b">${shapes}${txt(250, 312, `INSIDE VIEW · ${line.swing === "in" ? "INWARD / SOLID" : "OUTWARD / DASHED"} · ${line.columns} × ${line.rows}`, 11)}${txt(250, 333, "报价确认示意图 / QUOTATION CONFIRMATION DRAWING", 11)}${txt(250, 351, "NOT FOR PRODUCTION", 13)}</g></svg>`;
}
