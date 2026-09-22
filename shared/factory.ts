import { z } from "zod";
import { categories, methods } from "./quoting.ts";

const text = z.string().trim().max(2000).default("");
export const factoryProductSchema = z.object({
  sku: z.string().trim().min(1).max(80),
  nameZh: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().max(200).default(""),
  category: z.enum(categories),
  series: text,
  specification: text,
  imageUrls: z.array(z.string().url().max(1000)).max(12).default([]),
  supplyPrice: z.number().finite().min(0).max(1e9),
  currency: z.string().regex(/^[A-Z]{3}$/).default("CNY"),
  pricingMethod: z.enum(methods).default("area_options"),
  pricingRule: z.record(z.string(), z.unknown()).default({}),
  leadDays: z.number().int().min(0).max(1000).default(0),
  version: z.number().int().positive().optional(),
});
export type FactoryProductInput = z.infer<typeof factoryProductSchema>;
