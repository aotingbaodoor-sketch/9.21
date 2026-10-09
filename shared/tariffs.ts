import { z } from "zod";
export const isoCountry = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .refine((v) => {
    try {
      return (
        !["EU", "UN", "EZ", "QO", "XA", "XB", "ZZ"].includes(v) &&
        new Intl.DisplayNames(["en"], { type: "region" }).of(v) !== v
      );
    } catch {
      return false;
    }
  }, "请选择实际国家的两位代码，不能填地区联盟");
export const tariffDate = z.iso.date();
export const tariffRecordInput = z
  .object({
    sourceCode: z.string().regex(/^[a-z_]+$/),
    country: isoCountry,
    origin: isoCountry,
    hsCode: z.string().regex(/^\d{8,12}$/, "正式税则需目的国8—12位编码"),
    description: z.string().trim().min(3).max(1000),
    taxKind: z.enum(["duty", "vat", "extra", "export_rebate"]),
    rateText: z.string().trim().min(1).max(300),
    conditions: z.string().trim().min(10).max(4000),
    effectiveFrom: tariffDate,
    effectiveUntil: tariffDate.nullable(),
    dataYear: z.number().int().min(1990).max(2200),
    sourceUrl: z.url().refine((v) => /^https?:\/\//.test(v)),
    supersedesId: z.uuid().optional(),
  })
  .refine(
    (r) => !r.effectiveUntil || r.effectiveUntil >= r.effectiveFrom,
    "有效期错误",
  );
export const tariffSchedule = z
  .object({
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.literal("Asia/Shanghai"),
    usHeadings: z
      .array(z.string().regex(/^\d{4}$/))
      .min(1)
      .max(10),
  })
  .strict();
export type TariffRecord = {
  id: string;
  source_code: string;
  series_key: string;
  version: number;
  country: string;
  origin: string;
  hs_code: string;
  hs_level: number;
  description: string;
  tax_kind: string;
  rate_text: string;
  conditions: string;
  effective_from: string | null;
  effective_until: string | null;
  data_year: number | null;
  source_url: string;
  source_published_at: string | null;
  fetched_at: string;
  last_success_at: string;
  reference_only: boolean;
  is_current: boolean;
  verification: string;
  verified_by: string | null;
  verified_on: string | null;
  review_note: string | null;
  evidence_url: string | null;
  source_name?: string;
  source_status?: string;
  source_error?: string | null;
  reviewer_name?: string | null;
  warning?: string | null;
};
export type TariffSource = {
  code: string;
  region: string;
  countries: string;
  name: string;
  url: string;
  access_type: string;
  hs_level: string;
  authority: string;
  notes: string;
  requirements: string;
  enabled: boolean;
  status: string;
  checked_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  version: number;
};
export const tariffLabels: Record<string, string> = {
  duty: "关税",
  vat: "进口增值税",
  extra: "附加税费",
  export_rebate: "出口退税",
  connected: "真实数据已获取",
  manual: "待人工更新",
  needs_auth: "待授权",
  blocked: "访问受阻",
  unconfirmed: "接口待核实",
  failed: "同步失败",
  pending: "待人工复核",
  verified: "已复核",
  rejected: "复核驳回",
  superseded: "历史版本",
};
export type TariffDbRecord = TariffRecord & { raw_data?: unknown };
export function tariffWarning(
  r: TariffRecord,
  today = new Date().toISOString().slice(0, 10),
) {
  if (!r.is_current) return "历史版本，不能用于新报价";
  if (r.effective_until && r.effective_until < today) return "已过期";
  if (r.data_year && Number(today.slice(0, 4)) - r.data_year > 2)
    return "参考年份超过两年，须取得现行依据重新核验";
  if (r.reference_only) return "仅供参考，不能直接作为产品适用税率";
  if (r.verification !== "verified")
    return tariffLabels[r.verification] || "待复核";
  if (r.effective_from && r.effective_from > today) return "尚未生效";
  return null;
}
