import { z } from "zod";
import {
  tcTechnicalSchema,
  technicalDifferences,
  type TcTechnical,
} from "./technical.ts";
import { escapeXml } from "./drawing.ts";
export const CAD_ENGINE = "cad-v2-native-pdf-libredwg-0.13.3";
export const CAD_STATES: Record<string, string> = {
  draft: "深化草稿",
  submitted: "待审核",
  reviewed: "已审核",
  production_approved: "已批准生产",
  void: "已作废",
};
export const CAD_LIMITATIONS =
  "本轮生成外框立面、可选深度平面、尺寸及材料说明；剖面、固定方式、承载及玻璃选型须公司认可节点库和技术人员确认。所有生成图均为深化草稿，不能投产。";
const dimension = z.number().positive().max(100000).nullable();
export const cadParameters = z
  .object({
    units: z.literal("mm"),
    scaleConfirmed: z.literal(true),
    technical: tcTechnicalSchema,
    details: z.record(
      z.string(),
      z
        .object({
          openingWidthMm: dimension,
          openingHeightMm: dimension,
          leafWidthMm: dimension,
          leafHeightMm: dimension,
          depthMm: dimension,
          viewDirection: z.string().trim().min(1).max(100),
          location: z.string().max(200),
          evidence: z.string().trim().min(1).max(500),
        })
        .strict(),
    ),
    engineeringBasis: z.string().max(2000),
    notes: z.string().max(2000),
  })
  .strict();
export function cadConflicts(source: TcTechnical, actual: TcTechnical) {
  const result = technicalDifferences(source, actual);
  for (const item of actual.items) {
    const s = source.items.find((i) => i.lineKey === item.lineKey);
    if (s && s.quantity !== item.quantity)
      result.push(`${item.lineKey}: 深化图数量与TC不一致`);
  }
  return result;
}
export function cadSvg(primitives: any[], hidden: string[] = []) {
  const list = primitives.filter((p) => !hidden.includes(p.layer));
  const coords = list
    .flatMap((p) => p.points || (p.at ? [p.at] : []))
    .filter((p: any) => p.length === 2 && p.every(Number.isFinite));
  if (!coords.length)
    return '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><text x="30" y="60">No supported geometry - inspect original CAD</text></svg>';
  const bounds = coords.reduce(
    (b: number[], p: number[]) => [
      Math.min(b[0], p[0]),
      Math.max(b[1], p[0]),
      Math.min(b[2], p[1]),
      Math.max(b[3], p[1]),
    ],
    [Infinity, -Infinity, Infinity, -Infinity],
  );
  const [minX, maxX, minY, maxY] = bounds,
    span = Math.max(maxX - minX, maxY - minY, 1),
    pad = span * 0.08;
  const font = span / 80,
    stroke = span / 1200;
  const e = (v: unknown) => escapeXml(String(v ?? ""));
  const shapes = list
    .map((p) =>
      p.kind === "text"
        ? `<text x="${p.at[0]}" y="${-p.at[1]}" font-size="${font}" fill="#222">${e(p.text)}</text>`
        : p.points
          ? `<polyline points="${p.points.map((v: number[]) => `${v[0]},${-v[1]}`).join(" ")}${p.closed ? " " + p.points[0][0] + "," + -p.points[0][1] : ""}" fill="none" stroke="${p.layer === "DIMENSIONS" ? "#9b752b" : "#243c50"}" stroke-width="${stroke}"/>`
          : "",
    )
    .join("");
  // Extra right margin accounts for material annotations; SVG is server-generated, no external refs.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${-maxY - pad} ${maxX - minX + pad * 5} ${maxY - minY + pad * 2}" width="1100" height="760"><rect x="${minX - pad}" y="${-maxY - pad}" width="${maxX - minX + pad * 5}" height="${maxY - minY + pad * 2}" fill="white"/>${shapes}</svg>`;
}
