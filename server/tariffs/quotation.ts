import type { Db } from "../db.ts";
import type { QuoteInput } from "../../shared/quoting.ts";
import {
  tariffWarning,
  type TariffDbRecord as TariffRecord,
} from "../../shared/tariffs.ts";
import { HttpError } from "../domain.ts";
export async function tariffBasis(db: Db, input: QuoteInput, lock = false) {
  if (!["CIF", "DAP", "DDP"].includes(input.incoterm))
    return {
      required: false,
      records: [] as TariffRecord[],
      errors: [] as string[],
    };
  const errors: string[] = [],
    ctx = input.tariff;
  if (!ctx)
    return {
      required: true,
      records: [] as TariffRecord[],
      errors: [
        "G-37：缺少目的国、原产地、适用日期及逐项税则。请在报价“税率依据”填写，并到“海关税率与来源”复核。",
      ],
    };
  const names = [
    ctx.destination,
    ctx.destination === "GB" ? "UK" : "",
    new Intl.DisplayNames(["zh"], { type: "region" }).of(ctx.destination),
    new Intl.DisplayNames(["en"], { type: "region" }).of(ctx.destination),
  ].map((s) => s?.toUpperCase());
  if (!names.includes(input.country.toUpperCase()))
    errors.push("报价国家与税率目的国不一致（国家栏可直接填写两位国家代码）");
  if (ctx.applicableOn !== input.targetDate)
    errors.push("税率适用日须与报价目标出运日期一致");
  const ids = [
    ...new Set(input.lines.flatMap((l) => l.tariffRateIds || [])),
  ].sort();
  const records = (
    await db.query(
      `SELECT r.*,s.name source_name,s.status source_status,s.last_error source_error FROM tariff_records r JOIN tariff_source_registry s ON s.code=r.source_code WHERE r.id=ANY($1::uuid[]) ORDER BY r.id ${lock ? "FOR SHARE OF r,s" : ""}`,
      [ids],
    )
  ).rows as TariffRecord[];
  for (const line of input.lines) {
    const selected = records.filter((r) => line.tariffRateIds?.includes(r.id));
    if (
      !line.tariffHsCode ||
      !selected.length ||
      (line.tariffRateIds || []).length !== selected.length
    ) {
      errors.push(`明细 ${line.key} 缺少完整HS编码或有效税率记录`);
      continue;
    }
    if (!selected.some((r) => r.tax_kind === "duty"))
      errors.push(`明细 ${line.key} 缺少关税核验`);
    if (input.incoterm === "DDP" && !selected.some((r) => r.tax_kind === "vat"))
      errors.push(
        `明细 ${line.key} 缺少进口VAT核验（免税须有明确0%及证据，不能用空值代替）`,
      );
    for (const r of selected) {
      const why = tariffWarning(r, ctx.applicableOn);
      if (why) errors.push(`${r.hs_code}：${why}`);
      if (
        r.country !== ctx.destination ||
        r.origin !== ctx.origin ||
        r.hs_code !== line.tariffHsCode
      )
        errors.push(`${r.hs_code}：国家、原产地或HS与明细不符`);
      if (!r.effective_from || !r.data_year || !r.verified_by || !r.verified_on)
        errors.push(`${r.hs_code}：缺生效日期/年度/复核人/复核时间`);
      if (r.source_status === "failed" || r.source_status === "blocked")
        errors.push(`${r.hs_code}：来源异常，请管理员确认现行依据后重试`);
      if (r.tax_kind === "export_rebate")
        errors.push("出口退税不能替代进口税费");
    }
  }
  return {
    required: true,
    context: ctx,
    records: records.map(({ raw_data: _raw, ...r }) => r),
    errors: [...new Set(errors)],
  };
}
export async function assertTariffBasis(
  db: Db,
  input: QuoteInput,
  saved: unknown,
) {
  const basis = await tariffBasis(db, input, true);
  if (basis.errors.length)
    throw new HttpError(422, "G-37：" + basis.errors.join("；"));
  // Runtime check and snapshot comparison cover source refresh or revoked review after approval.
  const signature = (x: unknown) =>
    JSON.stringify(x, (_k, v) => (v instanceof Date ? v.toISOString() : v));
  const stable = (x: unknown) => {
    const b = x as typeof basis | undefined;
    return b?.records.map((r) => ({
      id: r.id,
      version: r.version,
      verification: r.verification,
      verified_on: r.verified_on,
      rate_text: r.rate_text,
      conditions: r.conditions,
      source_url: r.source_url,
    }));
  };
  if (basis.required && signature(stable(basis)) !== signature(stable(saved)))
    throw new HttpError(
      409,
      "G-37：税率版本或复核状态变化，请重新核算报价；历史已签发报价不变",
    );
}
