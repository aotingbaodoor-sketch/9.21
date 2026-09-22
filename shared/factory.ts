import { z } from "zod";
import {
  categories,
  methods,
  productSchema,
  packingSchema,
  basis,
} from "./quoting.ts";

const text = z.string().trim().max(2000).default("");
const money = z.number().finite().min(0).max(1e9);
const supplierPacking = packingSchema.omit({ salePerPackage: true });
export const factoryRuleSchema = z
  .object({
    minWidthMm: productSchema.shape.minWidthMm,
    maxWidthMm: productSchema.shape.maxWidthMm,
    minHeightMm: productSchema.shape.minHeightMm,
    maxHeightMm: productSchema.shape.maxHeightMm,
    minArea: productSchema.shape.minArea,
    linearBasis: productSchema.shape.linearBasis,
    priceValidUntil: productSchema.shape.priceValidUntil,
    drawing: productSchema.shape.drawing,
    standardSpecs: productSchema.shape.standardSpecs,
    packing: supplierPacking.default(supplierPacking.parse({})),
    bands: z
      .array(z.object({ maxArea: money, cost: money }))
      .max(50)
      .default([]),
    formula: z
      .array(
        z.object({
          name: text,
          basis: z.enum(basis),
          coefficient: money,
          cost: money,
        }),
      )
      .max(50)
      .default([]),
    options: z
      .array(
        z.object({
          id: z.string().min(1).max(80),
          group: text,
          nameZh: z.string().trim().min(1).max(200),
          nameEn: text,
          basis: z.enum(basis),
          cost: money.nullable().default(null),
          required: z.boolean().default(false),
        }),
      )
      .max(100)
      .default([]),
  })
  .superRefine((p, ctx) => {
    if (p.minWidthMm > p.maxWidthMm || p.minHeightMm > p.maxHeightMm)
      ctx.addIssue({ code: "custom", message: "最小尺寸不能超过最大尺寸" });
    if (new Set(p.options.map((o) => o.id)).size !== p.options.length)
      ctx.addIssue({ code: "custom", message: "选配编号不能重复" });
    if (p.bands.some((b, i) => i > 0 && b.maxArea <= p.bands[i - 1].maxArea))
      ctx.addIssue({ code: "custom", message: "面积档位上限必须递增" });
  });
export type FactoryRule = z.infer<typeof factoryRuleSchema>;
export const commercialPricesSchema = z.object({
  packingSale: money.nullable().default(null),
  bandSales: z.array(money).max(50).default([]),
  formulaSales: z.array(money).max(50).default([]),
  optionSales: z.record(z.string(), money).default({}),
});
export type CommercialPrices = z.infer<typeof commercialPricesSchema>;
export const pricingLabels: Record<string, string> = {
  area: "按面积（㎡）",
  area_options: "面积＋选配",
  unit: "按樘",
  set: "按套",
  linear: "按延米",
  piece: "按件",
  fixed: "整行固定总价",
  range: "面积档位（每件）",
  material: "材料构成",
  composite: "组合构成",
};
export const basisLabels: Record<string, string> = {
  area: "计费面积㎡",
  width: "宽度m",
  height: "高度m",
  perimeter: "周长m",
  one: "每件",
};
export const factoryProductSchema = z.object({
  sku: z.string().trim().min(1).max(80),
  nameZh: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().max(200).default(""),
  category: z.enum(categories),
  series: text,
  specification: text,
  imageUrls: z.array(z.string().url().max(1000)).max(12).default([]),
  imageIds: z.array(z.uuid()).max(12).default([]),
  supplyPrice: z.number().finite().min(0).max(1e9),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("CNY"),
  pricingMethod: z.enum(methods).default("area_options"),
  pricingRule: factoryRuleSchema.default(factoryRuleSchema.parse({})),
  leadDays: z.number().int().min(0).max(1000).default(0),
  version: z.number().int().positive().optional(),
});
export type FactoryProductInput = z.infer<typeof factoryProductSchema>;
export function factoryReadiness(
  rule: FactoryRule,
  method: FactoryProductInput["pricingMethod"],
): string[] {
  const issues: string[] = [];
  if (!rule.priceValidUntil) issues.push("请填写供货价有效期");
  const p = rule.packing;
  if (
    !p.configured ||
    !p.type.trim() ||
    p.depthMm <= 0 ||
    [p.kgPerSqm, p.fixedKg, p.tareKg, p.costPerPackage].some((v) => v === null)
  )
    issues.push("请完成包装类型、厚度、重量及包装成本；无费用的项请填0");
  if (method === "range" && !rule.bands.length)
    issues.push("面积档位计价至少需要一个档位");
  if (["material", "composite"].includes(method) && !rule.formula.length)
    issues.push("材料或组合计价至少需要一个构成项");
  if (rule.options.some((o) => o.cost === null))
    issues.push("请补齐全部选配的供货成本");
  return issues;
}
export type FactoryProduct = {
  id: string;
  factory_id: string;
  factory_name: string;
  sku: string;
  name_zh: string;
  name_en: string;
  category: FactoryProductInput["category"];
  series: string;
  specification: string;
  image_urls: string[];
  image_ids: string[];
  supply_price: string;
  currency: string;
  pricing_method: FactoryProductInput["pricingMethod"];
  pricing_rule: FactoryRule;
  lead_days: number;
  status: string;
  review_note: string;
  version: number;
};
