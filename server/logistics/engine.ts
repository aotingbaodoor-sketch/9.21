import { Decimal } from "decimal.js";
import {
  activeTerms,
  chargeLabels,
  logisticsPolicySchema,
  type CostRate,
  type LogisticsSnapshot,
} from "../../shared/logistics.ts";
import type {
  Calculation,
  QuoteInput,
  QuotationSettings,
} from "../../shared/quoting.ts";
import { round } from "../quoting/engine.ts";
const D = (v: Decimal.Value) => new Decimal(v);
/** Premium is included in the 110% insured value. Minimum premium is in the insurer's currency. */
export function insurancePremium(
  base: number,
  rate: number,
  unit: string,
  minimum: number,
  saleFxBuffer = 1,
) {
  const r = D(rate).div(unit === "permille" ? 1000 : 100),
    factor = r.mul(1.1),
    denominator = D(1).minus(factor.mul(saleFxBuffer));
  if (
    !["percent", "permille"].includes(unit) ||
    r.isNegative() || !Number.isFinite(saleFxBuffer) || saleFxBuffer < 1 ||
    denominator.lte(0)
  )
    throw new Error("保险费率单位或闭式分母无效");
  return round(Decimal.max(D(base).mul(factor).div(denominator), minimum));
}
export function applyLogistics(
  c: Calculation,
  input: QuoteInput,
  rates: CostRate[],
  settings: QuotationSettings,
  today: string,
) {
  const issue = (code: string, message: string, hard = true) =>
    c.issues.push({
      code,
      message,
      discipline: ["G-35", "landed-floor", "DDP-approval"].includes(code)
        ? "admin"
        : "logistics",
      hard,
    });
  const policy = logisticsPolicySchema.parse(settings.logisticsPolicy ?? {}),
    i = input.logistics;
  if (!activeTerms.includes(input.incoterm as (typeof activeTerms)[number]))
    issue("G-33", "新报价仅支持EXW、FOB、CIF、DAP、DDP；旧FCA/CFR单据仍保留");
  const transport =
    i?.transport ??
    {
      LCL: "sea",
      FCL: "sea",
      air: "air",
      courier: "air",
      rail: "rail",
      truck: "road",
      other: "multimodal",
    }[input.freightMode];
  if (
    ["FOB", "CIF"].includes(input.incoterm) &&
    !["sea", "inland_waterway"].includes(transport)
  )
    issue("G-33", `${input.incoterm}仅适用于海运或内河运输`);
  if (
    i &&
    ((["LCL", "FCL"].includes(input.freightMode) &&
      !["sea", "inland_waterway"].includes(transport)) ||
      (["air", "courier"].includes(input.freightMode) && transport !== "air") ||
      (input.freightMode === "rail" && transport !== "rail") ||
      (input.freightMode === "truck" && transport !== "road"))
  )
    issue("G-33", "运输方式与运价模式不一致");
  if (input.incoterm !== "EXW" && !i)
    issue("G-31", "请填写物流费用范围并选择真实费率");
  if (input.customerForwarder && !["EXW", "FOB"].includes(input.incoterm))
    issue("G-31", "客户指定货代不能免除本术语的卖方运输责任");
  const scope =
    i?.scope ?? "EXW厂内交货；买方负责装车、报关和运输；不含附加服务";
  const selected = i?.rateIds ?? [];
  if (selected.some((id) => !rates.some((r) => r.id === id)))
    issue("G-31", "所选费率不存在或无权使用");
  const components: LogisticsSnapshot["components"] = [],
    fx: Record<string, unknown> = {},
    expiry = [c.validThrough];
  const rateFx = (currency: string) => {
    if (currency === "CNY") return D(1);
    const r = settings.fx[currency];
    fx[currency] = r ?? null;
    if (
      !r ||
      r.date > today ||
      r.validUntil < today ||
      r.validUntil < input.validUntil
    ) {
      issue("G-31", `${currency}缺少覆盖报价期限的汇率`);
      return D(0);
    }
    expiry.push(r.validUntil);
    return D(r.cnyPerUnit);
  };
  const qfx = rateFx(input.currency),
    goodsSale = D(c.productTotal).plus(c.packingTotal).mul(qfx),
    goodsCost = D(c.private.costCny),
    qty = c.lines.reduce((s, l) => s + l.quantity, 0),
    markup = D(1).plus(D(input.freightMarkupPct).div(100)),
    quoteBuffer = D(1).plus(D(input.currency === "CNY" ? 0 : settings.fx[input.currency]?.bufferPct ?? 0).div(100));
  const required: Record<string, string[]> = {
    EXW: [],
    FOB: ["domestic", "export"],
    CIF: ["domestic", "export", "international", "insurance"],
    DAP: ["domestic", "export", "international", "destination", "delivery"],
    DDP: [
      "domestic",
      "export",
      "international",
      "destination",
      "delivery",
      "customs",
      "duty",
      "vat",
    ],
  };
  const included = new Set([
    ...(required[input.incoterm] ?? []),
    ...(i?.includedServices ?? []),
  ]);
  if (input.incoterm === "DDP" && rates.some((r) => r.kind === "extra"))
    included.add("extra");
  const usedKinds = new Set<string>();
  const add = (
    key: string,
    kind: string,
    value: Decimal.Value,
    basis: string,
  ) => {
    components.push({ key, kind, costCny: round(value), basis });
    usedKinds.add(kind);
  };
  const f = c.private.freight;
  if (f && input.incoterm !== "EXW") {
    if (
      !f.active ||
      f.country.toLowerCase() !== input.country.toLowerCase() ||
      (f.city && f.city.toLowerCase() !== input.city.toLowerCase()) ||
      f.originPort !== input.originPort ||
      f.destinationPort !== input.destinationPort ||
      f.mode !== input.freightMode
    )
      issue("G-31", "现有运价与国家、城市、港口或运输模式不匹配");
    if (
      f.validFrom > today ||
      f.validFrom > input.targetDate ||
      f.validUntil < today ||
      f.validUntil < input.validUntil ||
      f.validUntil < input.targetDate
    )
      issue("G-32", "运价未生效或未覆盖报价/发运日期");
    if (!f.provenance)
      issue("G-31", "运价缺少原始报价来源和凭据，请先导入核准");
    if (
      f.limits &&
      ((f.limits.minCbm !== null && c.cbm < f.limits.minCbm) ||
        (f.limits.maxCbm !== null && c.cbm > f.limits.maxCbm) ||
        (f.limits.minKg !== null && c.grossKg < f.limits.minKg) ||
        (f.limits.maxKg !== null && c.grossKg > f.limits.maxKg))
    )
      issue("G-31", "货物超出运价重量/体积适用条件");
    if (f.mode === "FCL" && !c.containers.includes(f.container))
      issue(
        "G-31",
        "包装不能按已配置柜型核实，须拆分核算，不按估计柜数自动放行",
      );
    expiry.push(f.validUntil);
    for (const fee of f.fees.filter((v) => included.has(v.kind))) {
      if (["duty", "insurance"].includes(fee.kind)) {
        issue(
          "G-31",
          `${chargeLabels[fee.kind]}须使用独立核验费率，不能与旧运价中的包干金额重复计入`,
        );
        continue;
      }
      if (!f.confirmed.includes(fee.kind))
        issue("G-31", `${chargeLabels[fee.kind]}尚未确认`);
      if (fee.basis === "chargeableKg" && !f.volumetricKgPerCbm)
        issue("G-31", "缺少计费体积重系数");
      const measure = {
        fixed: 1,
        cbm: c.cbm,
        kg: c.grossKg,
        chargeableKg: Math.max(c.grossKg, c.cbm * f.volumetricKgPerCbm),
        container: i?.containers ?? 1,
      }[fee.basis];
      add(
        `freight:${f.id}:${components.length}`,
        fee.kind,
        Decimal.max(D(fee.rate).mul(measure), fee.minimum).mul(
          rateFx(f.currency),
        ),
        `${measure} × ${fee.rate} ${f.currency}/${fee.basis}`,
      );
    }
  }
  for (const r of rates) {
    if (!r.is_current) issue("G-36", `${r.name}已升版，请重新核算`);
    if (
      r.validFrom > today ||
      r.validFrom > input.targetDate ||
      r.validUntil < today ||
      r.validUntil < input.validUntil ||
      r.validUntil < input.targetDate
    )
      issue("G-32", `${r.name}未生效或已过期/未覆盖发运日期`);
    if (
      r.country !== input.country ||
      (r.originPort && r.originPort !== input.originPort) ||
      (r.destination &&
        ![input.city, input.destinationPort, input.namedPlace].includes(
          r.destination,
        )) ||
      (r.transport !== "any" && r.transport !== transport)
    )
      issue("G-31", `${r.name}适用国家、地点或运输方式不匹配`);
    if (!included.has(r.kind))
      issue("G-31", `${r.name}不在所选术语/合同附加服务范围内`);
    expiry.push(r.validUntil);
    if (["insurance", "duty", "vat", "extra"].includes(r.kind)) continue;
    if (usedKinds.has(r.kind)) {
      issue("G-31", `${chargeLabels[r.kind]}重复计费；请合并到一份核准报价中`);
      continue;
    }
    if (["percent", "permille"].includes(r.unit)) {
      issue("G-31", "非保险/税费不能使用百分比费率");
      continue;
    }
    const measure = {
      fixed: 1,
      container: i?.containers ?? 1,
      cbm: c.cbm,
      kg: c.grossKg,
      piece: qty,
      day: i?.storageDays ?? 0,
    }[r.unit as "fixed"];
    if (r.unit === "day" && !measure) issue("G-31", "仓储按天计价必须填写天数");
    add(
      r.id,
      r.kind,
      Decimal.max(D(r.rate).mul(measure), r.minimum).mul(rateFx(r.currency)),
      `${measure} × ${r.rate} ${r.currency}/${r.unit}`,
    );
  }
  const preInsurance = components.reduce((s, r) => s.plus(r.costCny), D(0)),
    insuranceRates = rates.filter((r) => r.kind === "insurance");
  if (insuranceRates.length > 1) issue("G-31", "保险重复选择");
  for (const r of insuranceRates.slice(0, 1)) {
    const x = rateFx(r.currency);
    if (x.isZero()) continue;
    try {
      const premium = insurancePremium(
        goodsSale.plus(preInsurance.mul(markup).mul(quoteBuffer)).div(x).toNumber(),
        r.rate,
        r.unit,
        r.minimum,
        quoteBuffer.toNumber(),
      );
      add(
        r.id,
        "insurance",
        D(premium).mul(x),
        `110%投保；I=max(B×1.1r/(1−1.1r×汇率缓冲${quoteBuffer}),最低保费)，保险不加运费利润`,
      );
    } catch (e) {
      issue("G-31", (e as Error).message);
    }
  }
  const taxAmounts = new Map<string, Decimal>(),
    pending = rates.filter((r) => ["duty", "vat", "extra"].includes(r.kind));
  if (input.incoterm === "DDP")
    for (const line of input.lines)
      for (const id of line.tariffRateIds ?? [])
        if (!pending.some((r) => r.tariffId === id))
          issue(
            "G-37",
            "每项选择的正式税种均需配置对应计税公式，不能漏算附加税",
          );
  for (let pass = 0; pending.length && pass <= rates.length; pass++)
    for (const r of [...pending]) {
      if (r.priorTaxes.some((id) => !taxAmounts.has(id))) continue;
      const t = c.tariffBasis?.records.find((t) => t.id === r.tariffId);
      const percentage = t?.rate_text.match(/^\s*(\d+(?:\.\d+)?)\s*%\s*$/);
      if (
        !t ||
        t.tax_kind !== r.kind ||
        t.verification !== "verified" ||
        !percentage ||
        !D(percentage[1]).eq(r.rate)
      )
        issue(
          "G-37",
          `${r.name}的百分比计算值与已核验T40税种/数值不一致（复合税不支持自动计算）`,
        );
      const applicableKeys = input.lines
          .filter((l) => l.tariffRateIds?.includes(r.tariffId ?? ""))
          .map((l) => l.key),
        lineValue = c.lines
          .filter((l) => applicableKeys.includes(l.key))
          .reduce((s, l) => s.plus(l.productTotal).plus(l.packingTotal), D(0))
          .mul(qfx);
      const ratio = goodsSale.gt(0) ? lineValue.div(goodsSale) : D(0);
      if (ratio.isZero()) issue("G-37", `${r.name}未关联具体产品HS税目`);
      let base = D(0);
      for (const k of r.taxBase) {
        if (k === "goods") base = base.plus(lineValue);
        else {
          const found = components.filter((v) => v.kind === k);
          if (!found.length)
            issue("G-31", `${r.name}缺少计税基础项：${chargeLabels[k]}`);
          base = base.plus(
            found.reduce((s, v) => s.plus(v.costCny), D(0)).mul(ratio),
          );
        }
      }
      for (const id of r.priorTaxes) {
        const prior = rates.find(v => v.id === id);
        const priorKeys = input.lines.filter(l => l.tariffRateIds?.includes(prior?.tariffId ?? "")).map(l => l.key);
        if (priorKeys.length !== applicableKeys.length || priorKeys.some(k => !applicableKeys.includes(k)))
          issue("G-37", `${r.name}与前序税对应的产品范围不同，须按相同税目范围分别核算`);
        base = base.plus(taxAmounts.get(id)!);
      }
      const value = D(round(base.mul(r.rate).div(100)));
      taxAmounts.set(r.id, value);
      add(
        r.id,
        r.kind,
        value,
        `已核验税目${t?.hs_code ?? "缺失"}；${r.taxBase.join("+")}+前序税，金额基础${round(base)} CNY × ${r.rate}%`,
      );
      pending.splice(pending.indexOf(r), 1);
    }
  if (pending.length)
    issue("G-37", "计税顺序存在循环、缺失前序税种或未选择依赖版本");
  for (const k of included)
    if (!usedKinds.has(k)) issue("G-31", `缺少已确认费用：${chargeLabels[k]}`);
  const logisticsCost = components.reduce((s, r) => s.plus(r.costCny), D(0)),
    cost = goodsCost.plus(logisticsCost),
    ddp = i?.ddp;
  let risk = D(0);
  if (input.incoterm === "DDP") {
    if (!ddp)
      issue(
        "G-34",
        "DDP须填写法定清关主体、资格凭据、税费上限、服务边界与风险缓冲",
      );
    else {
      risk = (ddp.riskBase === "full_cost" ? cost : goodsCost)
        .mul(ddp.riskPct)
        .div(100);
      const taxes = components
        .filter((r) => ["duty", "vat", "extra"].includes(r.kind))
        .reduce((s, r) => s.plus(r.costCny), D(0));
      if (taxes.gt(D(ddp.taxCap).mul(qfx)))
        issue("G-34", "核算税费超过合同税费上限，请重新确认边界");
    }
    issue(
      "DDP-approval",
      "DDP逐单特批：须指派管理员人工审查清关资格、服务边界和风险缓冲",
      false,
    );
  }
  // Risk buffer applies once, not to costs and not again through freightMarkupPct.
  const freightSale = components
    .reduce(
      (s, r) =>
        s.plus(
          D(r.costCny).mul(
            ["insurance", "duty", "vat", "extra"].includes(r.kind) ? 1 : markup,
          ).mul(quoteBuffer),
        ),
      D(0),
    )
    .plus(risk);
  const total = qfx.gt(0) ? round(goodsSale.plus(freightSale).div(qfx)) : null,
    sale = total === null ? null : D(total).mul(qfx),
    floor = cost.mul(policy.landedMultiplier);
  if (sale && sale.lt(cost))
    issue("G-35", "对客总价低于实际全链路成本，任何角色均不得放行");
  if (input.incoterm !== "EXW" && sale && sale.lt(floor))
    issue("landed-floor", "报价低于配置的全链路底线，需要人工审批", false);
  c.freightTotal = qfx.gt(0) ? round(freightSale.div(qfx)) : null;
  c.total = c.issues.some((v) => v.hard) ? null : total;
  c.validThrough = expiry.sort()[0];
  c.private.costCny = round(cost);
  c.private.freightCostCny = round(logisticsCost);
  c.private.marginPct = sale?.gt(0)
    ? round(sale.minus(cost).div(sale).mul(100))
    : null;
  c.private.logistics = {
    ruleVersion: "logistics-1.1",
    term: input.incoterm,
    policy,
    scope,
    rates,
    fx,
    components,
    goodsCostCny: round(goodsCost),
    costCny: round(cost),
    floorCny: round(floor),
    saleCny: sale ? round(sale) : null,
    riskCny: round(risk),
    profitCny: sale ? round(sale.minus(cost)) : null,
    input: i ?? null,
  };
  c.logisticsSummary = {
    ruleVersion: "logistics-1.1",
    scope,
    term: input.incoterm,
    rateVersions: rates.map((r) => ({
      id: r.id,
      version: r.version,
      name: r.name,
      provider: r.provider,
      validUntil: r.validUntil,
    })),
    exportDeclarant: input.incoterm === "EXW" ? "buyer" : "seller",
    rebateEnabled: false,
  };
  return c;
}
