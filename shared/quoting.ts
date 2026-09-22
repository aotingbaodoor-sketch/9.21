import { z } from "zod";
import { dateSchema } from "./contracts.ts";

const text = z.string().trim().max(2000).default("");
const money = z.number().finite().min(0).max(1e9);
const price = money.nullable().default(null);
const percent = z.number().min(0).max(100);
export const categories = ["平开窗", "推拉窗", "平开门", "推拉门", "折叠门", "提升推拉门", "转轴门", "入户门", "全铝室内门", "铝木门", "隐形门", "艺术玻璃门", "淋浴房", "五金配件", "定制产品"] as const;
export const terms = ["EXW", "FCA", "FOB", "CFR", "CIF", "DAP", "DDP"] as const;
export const methods = ["area", "unit", "set", "linear", "piece", "fixed", "area_options", "range", "material", "composite"] as const;
export const basis = ["area", "width", "height", "perimeter", "one"] as const;
export const feeKinds = ["domestic", "export", "international", "insurance", "destination", "customs", "duty", "delivery", "other"] as const;
export const optionSchema = z.object({ id: z.string().min(1).max(80), group: text, nameZh: text, nameEn: text, basis: z.enum(basis).default("one"), cost: price, sale: price, required: z.boolean().default(false) });
export const packingSchema = z.object({
  configured: z.boolean().default(false), type: text, widthAllowanceMm: money.default(0), heightAllowanceMm: money.default(0), depthMm: money.default(0),
  unitsPerPackage: z.number().int().min(1).max(100).default(1), kgPerSqm: price, fixedKg: price, tareKg: price, costPerPackage: price, salePerPackage: price,
  fragile: z.boolean().default(true), fumigation: z.boolean().default(false), stackable: z.boolean().default(false), maxPieceKg: price, maxLengthMm: price,
});
export const productSchema = z.object({
  sku: z.string().trim().min(1).max(80), nameZh: z.string().trim().min(1).max(200), nameEn: z.string().trim().min(1).max(200), category: z.enum(categories), series: text,
  introduction: text, active: z.boolean().default(true), leadDays: z.number().int().min(0).max(1000).default(0),
  imageIds: z.array(z.uuid()).max(12).default([]),
  minWidthMm: money.default(1), maxWidthMm: money.default(10000), minHeightMm: money.default(1), maxHeightMm: money.default(10000),
  minArea: money.default(0), pricing: z.enum(methods).default("area_options"), linearBasis: z.enum(["width", "height", "perimeter"]).default("perimeter"),
  prices: z.object({ factory: price, internal: price, guide: price, minimum: price, retail: price, special: price }).default({ factory: null, internal: null, guide: null, minimum: null, retail: null, special: null }),
  priceValidUntil: dateSchema.nullable().default(null),
  bands: z.array(z.object({ maxArea: money, cost: money, sale: money })).max(50).default([]),
  formula: z.array(z.object({ name: text, basis: z.enum(basis), coefficient: money, cost: money, sale: money })).max(50).default([]),
  options: z.array(optionSchema).max(100).default([]), standardSpecs: z.record(z.string().max(80), z.string().max(500)).default({}),
  drawing: z.enum(["casement", "sliding", "folding", "pivot", "fixed", "custom"]).default("casement"), packing: packingSchema.default(packingSchema.parse({})),
}).superRefine((p, ctx) => {
  if (p.minWidthMm > p.maxWidthMm || p.minHeightMm > p.maxHeightMm) ctx.addIssue({ code: "custom", message: "最小尺寸不能超过最大尺寸" });
  if (new Set(p.options.map(o => o.id)).size !== p.options.length) ctx.addIssue({ code: "custom", message: "选项 ID 不得重复" });
  if (p.bands.some((b, i) => i > 0 && b.maxArea <= p.bands[i - 1].maxArea)) ctx.addIssue({ code: "custom", message: "尺寸档位必须按面积上限递增" });
});
export const policySchema = z.object({ viewCosts: z.boolean().default(false), viewFreightCost: z.boolean().default(false), maxDiscountPct: percent.default(0), minMarginPct: percent.max(99).default(0), canAdjustUnitPrice: z.boolean().default(false), requireApproval: z.boolean().default(false) });
export const quotationSettingsSchema = z.object({
  configured: z.boolean().default(false), companyZh: text.default("佛山奥汀堡建材公司"), companyEn: text.default("AUTINBERG"), address: text, contact: text,
  logo: z.string().max(150000).regex(/^(|data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+)$/).default(""),
  minMarginPct: percent.max(99).default(0), defaultPolicy: policySchema.default(policySchema.parse({})), policies: z.record(z.uuid(), policySchema).default({}),
  fx: z.record(z.string().regex(/^[A-Z]{3}$/), z.object({ cnyPerUnit: z.number().positive().max(1e6), date: dateSchema, validUntil: dateSchema, source: z.string().min(1).max(500), bufferPct: percent })).default({}),
  showPackingNotice: z.boolean().default(true), termsZh: text, termsEn: text, bankDetails: text, contractZh: text, contractEn: text, contractApproved: z.boolean().default(false),
  fcaFees: z.array(z.enum(feeKinds)).default([]), fcaConfigured: z.boolean().default(false),
  containers: z.array(z.object({ name: z.string().min(1).max(40), cbm: z.number().positive(), kg: z.number().positive(), lengthMm: z.number().positive(), widthMm: z.number().positive(), heightMm: z.number().positive() })).max(20).default([]),
});
export const freightSchema = z.object({
  name: z.string().trim().min(1).max(150), active: z.boolean().default(true), country: z.string().min(1).max(100), city: text, originPort: text, destinationPort: text,
  mode: z.enum(["LCL", "FCL", "air", "courier", "rail", "truck", "other"]).default("LCL"), currency: z.string().regex(/^[A-Z]{3}$/),
  validFrom: dateSchema, validUntil: dateSchema, forwarder: text, transitDays: text, inclusions: text, exclusions: text,
  projectId: z.uuid().nullable().default(null), source: z.enum(["standard", "forwarder", "recent", "project"]).default("standard"),
  container: text, volumetricKgPerCbm: money.default(0), confirmed: z.array(z.enum(feeKinds)).default([]),
  fees: z.array(z.object({ kind: z.enum(feeKinds), basis: z.enum(["fixed", "cbm", "kg", "chargeableKg", "container"]), rate: money, minimum: money.default(0) })).max(40),
}).refine(r => r.validFrom <= r.validUntil, "运价有效期无效");
export const lineSchema = z.object({
  key: z.string().min(1).max(80), productId: z.uuid(), location: text, floor: text, room: text, openingNumber: text,
  width: z.number().positive().max(100000), height: z.number().positive().max(100000), unit: z.enum(["mm", "cm", "m"]).default("mm"), quantity: z.number().int().min(1).max(10000),
  columns: z.number().int().min(1).max(8).default(2), rows: z.number().int().min(1).max(6).default(1),
  panels: z.array(z.enum(["fixed", "left", "right"])).min(1).max(48).default(["fixed", "right"]), swing: z.enum(["in", "out"]).default("in"),
  options: z.array(z.string().max(80)).max(100).default([]), specs: z.record(z.string().max(80), z.string().max(500)).default({}),
  special: text, notes: text, unitPrice: price, discountPct: percent.default(0), nonstandard: z.boolean().default(false),
});
export const quoteInputSchema = z.object({
  name: z.string().trim().min(1).max(150), country: z.string().trim().min(1).max(100), city: text, projectAddress: text, deliveryAddress: text, originPort: text, destinationPort: text,
  currency: z.string().regex(/^[A-Z]{3}$/), incoterm: z.enum(terms), namedPlace: text, targetDate: dateSchema, validUntil: dateSchema,
  freightId: z.uuid().nullable().default(null), freightMode: z.enum(["LCL", "FCL", "air", "courier", "rail", "truck", "other"]).default("LCL"), customerForwarder: z.boolean().default(false),
  freightMarkupPct: percent.default(0), freightDisplay: z.enum(["separate", "line", "allocated", "total"]).default("separate"),
  language: z.enum(["en", "zh", "both"]).default("en"), paymentTerms: text, notes: text, lines: z.array(lineSchema).min(1).max(100),
}).refine(q => new Set(q.lines.map(l => l.key)).size === q.lines.length, "明细编号不得重复");
export type Product = z.infer<typeof productSchema> & { id: string; version: number };
export type QuoteInput = z.infer<typeof quoteInputSchema>;
export type QuoteLine = z.infer<typeof lineSchema>;
export type QuotationSettings = z.infer<typeof quotationSettingsSchema>;
export type QuotePolicy = z.infer<typeof policySchema>;
export type Freight = z.infer<typeof freightSchema> & { id: string; version: number };
export type Issue = { code: string; message: string; discipline: "admin" | "technical" | "logistics"; hard: boolean; line?: string };
export type Packed = { packages: number; cbm: number; netKg: number; grossKg: number; widthMm: number; heightMm: number; depthMm: number; type: string; fragile: boolean; fumigation: boolean; stackable: boolean };
export type CalculatedLine = { key: string; sku: string; nameZh: string; nameEn: string; widthMm: number; heightMm: number; area: number; billedArea: number; quantity: number; unitPrice: number; productTotal: number; packingTotal: number; packed: Packed; svg: string; specs: Record<string, string>; options: string[]; location: string; special: string; private: { cost: number; minimum: number; marginPct: number; product: Product } };
export type Calculation = { lines: CalculatedLine[]; issues: Issue[]; currency: string; productTotal: number; packingTotal: number; freightTotal: number | null; total: number | null; packages: number; cbm: number; netKg: number; grossKg: number; containers: string[]; validThrough: string; private: { costCny: number; marginPct: number | null; freightCostCny: number | null; freight: Freight | null; settings: QuotationSettings; fx: unknown; policy: QuotePolicy } };
export type PublicCalculation = Omit<Calculation, "private" | "lines"> & { lines: Omit<CalculatedLine, "private">[]; costs?: { costCny: number; marginPct: number | null }; freightCosts?: { freightCostCny: number | null }; lineCosts?: { cost: number; minimum: number; marginPct: number }[] };
export const specLabels: Record<string, string> = { profile: "型材 / Profile", thickness: "型材厚度 / Profile thickness", finish: "表面工艺 / Finish", color: "颜色 / Color", glass: "玻璃 / Glass", glassThickness: "玻璃厚度 / Glass thickness", cavity: "中空层 / Cavity", hardwareBrand: "五金品牌 / Hardware brand", hardwareModel: "五金型号 / Hardware model", lock: "锁具 / Lock", hinge: "合页 / Hinge", screen: "纱网 / Screen", trim: "门套 / Trim", wallThickness: "墙厚 / Wall thickness", moisture: "防潮 / Moisture", termite: "防蚁 / Termite", acoustic: "隔音 / Acoustic", fire: "防火 / Fire" };
