import { z } from "zod";
export const activeTerms = ["EXW", "FOB", "CIF", "DAP", "DDP"] as const;
export const chargeKinds = [
  "domestic",
  "export",
  "international",
  "insurance",
  "destination",
  "customs",
  "duty",
  "vat",
  "extra",
  "delivery",
  "unloading",
  "installation",
  "materials",
  "storage",
  "other",
] as const;
export const chargeLabels: Record<string, string> = {
  domestic: "国内段",
  export: "出口报关",
  international: "主运输",
  insurance: "保险",
  destination: "目的港杂费",
  customs: "进口清关服务",
  duty: "进口关税",
  vat: "进口增值税",
  extra: "附加税",
  delivery: "末端派送",
  unloading: "卸货",
  installation: "安装",
  materials: "辅材",
  storage: "仓储",
  other: "其他合同费用",
};
export const unitLabels: Record<string, string> = {
  fixed: "每票",
  container: "每柜",
  cbm: "每立方米",
  kg: "每公斤",
  piece: "每件",
  day: "每天",
  percent: "百分比 %",
  permille: "千分比 ‰",
};
const amount = z.number().finite().min(0).max(1e9);
export const logisticsPolicySchema = z.object({
  floorMultiplier: z.number().min(1).max(10).default(1.2),
  landedMultiplier: z.number().min(1).max(10).default(1.15),
  defaultTerm: z.literal("EXW").default("EXW"),
  exportDeclarant: z.literal("buyer").default("buyer"),
  rebateEnabled: z.literal(false).default(false),
});
export const rateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    kind: z.enum(chargeKinds),
    country: z.string().trim().min(1).max(100),
    originPort: z.string().trim().max(160).default(""),
    destination: z.string().trim().max(160).default(""),
    transport: z
      .enum([
        "any",
        "sea",
        "inland_waterway",
        "air",
        "rail",
        "road",
        "multimodal",
      ])
      .default("any"),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unit: z.enum([
      "fixed",
      "container",
      "cbm",
      "kg",
      "piece",
      "day",
      "percent",
      "permille",
    ]),
    rate: amount,
    minimum: amount.default(0),
    validFrom: z.iso.date(),
    validUntil: z.iso.date(),
    sourceDate: z.iso.date(),
    provider: z.string().trim().min(1).max(200),
    evidence: z.string().trim().min(5).max(1000),
    scope: z.string().trim().min(5).max(2000),
    tariffId: z.uuid().nullable().default(null),
    taxBase: z
      .array(
        z.enum([
          "goods",
          "domestic",
          "export",
          "international",
          "insurance",
          "destination",
          "customs",
          "delivery",
          "unloading",
          "installation",
          "materials",
          "storage",
          "other",
        ]),
      )
      .max(14)
      .default([]),
    priorTaxes: z.array(z.uuid()).max(20).default([]),
  })
  .superRefine((r, c) => {
    if (r.validUntil < r.validFrom)
      c.addIssue({ code: "custom", message: "有效期结束不能早于开始" });
    if (r.kind === "insurance" && !["percent", "permille"].includes(r.unit))
      c.addIssue({ code: "custom", message: "保险必须明确百分比或千分比" });
    if (
      ["duty", "vat", "extra"].includes(r.kind) &&
      (!r.tariffId || !r.taxBase.length || r.unit !== "percent")
    )
      c.addIssue({
        code: "custom",
        message:
          "税费须关联已核验T40版本，明确百分比计税基础和先后税种；复合/从量税请待专门核算，不能套用百分比",
      });
    if (["duty", "vat", "extra"].includes(r.kind) && r.minimum !== 0)
      c.addIssue({ code: "custom", message: "最低税额属于专门计税规则，当前百分比税费不能设置最低收费" });
    if (
      new Set(r.taxBase).size !== r.taxBase.length ||
      new Set(r.priorTaxes).size !== r.priorTaxes.length
    )
      c.addIssue({ code: "custom", message: "计税基础不得重复" });
  });
export type CostRate = z.infer<typeof rateSchema> & {
  id: string;
  series_id: string;
  version: number;
  is_current: boolean;
};
export const logisticsInputSchema = z
  .object({
    rateIds: z.array(z.uuid()).max(50).default([]),
    transport: z.enum([
      "sea",
      "inland_waterway",
      "air",
      "rail",
      "road",
      "multimodal",
    ]),
    containers: z.number().int().min(1).max(1000).default(1),
    storageDays: z.number().int().min(0).max(3650).default(0),
    includedServices: z
      .array(
        z.enum([
          "unloading",
          "installation",
          "materials",
          "storage",
          "other",
          "insurance",
        ]),
      )
      .max(6)
      .default([]),
    scope: z.string().trim().min(5).max(2000),
    ddp: z
      .object({
        clearingParty: z.string().trim().min(1).max(300),
        qualificationEvidence: z.string().trim().min(10).max(2000),
        qualificationConfirmed: z.literal(true),
        taxCap: amount,
        boundary: z.string().trim().min(10).max(3000),
        riskPct: z.number().min(20).max(30),
        riskBase: z.enum(["full_cost", "goods_cost"]),
        riskReason: z.string().trim().min(10).max(1000),
      })
      .optional(),
  })
  .refine(
    (i) =>
      new Set(i.rateIds).size === i.rateIds.length &&
      new Set(i.includedServices).size === i.includedServices.length,
    "费用及附加服务不得重复选择",
  );
export type LogisticsInput = z.infer<typeof logisticsInputSchema>;
export type LogisticsSnapshot = {
  ruleVersion: "logistics-1.1";
  term: string;
  policy: z.infer<typeof logisticsPolicySchema>;
  scope: string;
  rates: CostRate[];
  fx: Record<string, unknown>;
  components: { key: string; kind: string; costCny: number; basis: string }[];
  goodsCostCny: number;
  costCny: number;
  floorCny: number;
  saleCny: number | null;
  riskCny: number;
  profitCny: number | null;
  input: LogisticsInput | null;
};
export const stageApplicable = (stage: string, term: string) =>
  !(term === "EXW" && ["loaded", "export_cleared"].includes(stage));
