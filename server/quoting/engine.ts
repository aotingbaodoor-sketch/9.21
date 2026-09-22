import { Decimal } from "decimal.js";
import type { Calculation, Freight, Issue, Packed, Product, PublicCalculation, QuoteInput, QuotePolicy, QuotationSettings } from "../../shared/quoting.ts";
import { drawProduct } from "../../shared/drawing.ts";
const d = (v: Decimal.Value) => new Decimal(v);
export const round = (v: Decimal.Value, places = 2) => d(v).toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toNumber();
export const sum = (v: Decimal.Value[]) => v.reduce<Decimal>((a, b) => a.plus(b), d(0));
export function policy(settings: QuotationSettings, user: { id: string; role: string }): QuotePolicy {
  return user.role === "admin" ? { ...settings.defaultPolicy, viewCosts: true, viewFreightCost: true, maxDiscountPct: 100, canAdjustUnitPrice: true, requireApproval: false } : settings.policies[user.id] || settings.defaultPolicy;
}
export function publicCalculation(c: Calculation, p: QuotePolicy): PublicCalculation {
  const { private: priv, lines, ...rest } = c;
  return { ...rest, lines: lines.map(({ private: _private, ...l }) => l), ...(p.viewCosts ? { costs: { costCny: priv.costCny, marginPct: priv.marginPct }, lineCosts: lines.map(l => ({ cost: l.private.cost, minimum: l.private.minimum, marginPct: l.private.marginPct })) } : {}), ...(p.viewFreightCost ? { freightCosts: { freightCostCny: priv.freightCostCny } } : {}) };
}
export function calculate(input: QuoteInput, products: Product[], freight: Freight | null, settings: QuotationSettings, permission: QuotePolicy, today: string, projectId: string): Calculation {
  const issues: Issue[] = [], expiry = [input.validUntil];
  const issue = (code: string, message: string, discipline: Issue["discipline"] = "admin", hard = true, line?: string) => { issues.push({ code, message, discipline, hard, ...(line ? { line } : {}) }); };
  const fx = (currency: string) => {
    if (currency === "CNY") return { cnyPerUnit: 1, bufferPct: 0 };
    const rate = settings.fx[currency];
    if (!rate || rate.date > today || rate.validUntil < today || rate.validUntil < input.validUntil) { issue("fx", `${currency} 缺少覆盖报价有效期的已核实汇率`); return { cnyPerUnit: 1, bufferPct: 0 }; }
    expiry.push(rate.validUntil); return rate;
  };
  const quoteFx = fx(input.currency), convert = (v: Decimal.Value) => d(v).div(quoteFx.cnyPerUnit).mul(d(1).plus(d(quoteFx.bufferPct).div(100)));
  if (!settings.configured) issue("settings", "管理员尚未确认公司报价规则");
  if (!settings.address || !settings.contact) issue("company", "公司地址与联系方式尚未配置");
  if (!input.namedPlace || !input.paymentTerms) issue("terms", "请填写贸易条款指定地点和付款条款");
  if (input.validUntil < today || input.targetDate < today) issue("expired", "报价有效期或目标发货日期已过期");
  if (permission.requireApproval) issue("policy", "该销售的所有报价需要审批", "admin", false);
  let totalCost = d(0);
  const lines = input.lines.flatMap(line => {
    const p = products.find(p => p.id === line.productId);
    if (!p || !p.active) { issue("product", "产品不存在或已停用", "admin", true, line.key); return []; }
    if (!p.priceValidUntil || p.priceValidUntil < input.validUntil || p.priceValidUntil < today) issue("price-expired", `${p.sku} 产品价格有效期不足`, "admin", true, line.key);
    if (p.priceValidUntil) expiry.push(p.priceValidUntil);
    const factor = line.unit === "mm" ? 1 : line.unit === "cm" ? 10 : 1000;
    const width = d(line.width).mul(factor), height = d(line.height).mul(factor), area = width.mul(height).div(1e6), billedArea = Decimal.max(area, p.minArea);
    const bases = { one: d(1), area: billedArea, width: width.div(1000), height: height.div(1000), perimeter: width.plus(height).div(500) };
    if (width.gt(p.maxWidthMm) || width.lt(p.minWidthMm) || height.gt(p.maxHeightMm) || height.lt(p.minHeightMm) || line.nonstandard || line.special || p.drawing === "custom") issue("nonstandard", `${p.sku} 非标尺寸/特殊要求，需技术图纸与管理员核价`, "technical", false, line.key);
    if (issues.some(i => i.line === line.key && i.code === "nonstandard")) issue("nonstandard-price", `${p.sku} 非标价格待管理员确认`, "admin", false, line.key);
    if (line.panels.length !== line.columns * line.rows) issue("panels", `${p.sku} 扇数与横竖分格不一致`, "technical", true, line.key);
    const base = p.pricing === "area" || p.pricing === "area_options" ? bases.area : p.pricing === "linear" ? bases[p.linearBasis] : p.pricing === "fixed" ? d(1).div(line.quantity) : bases.one;
    if (p.prices.internal === null || p.prices.guide === null || p.prices.minimum === null) issue("price", `${p.sku} 缺少内部成本、指导价或最低价`, "admin", true, line.key);
    let cost = base.mul(p.prices.internal || 0), sale = base.mul(p.prices.guide || 0), minimum = base.mul(p.prices.minimum || 0);
    if (p.pricing === "range") {
      const band = p.bands.find(b => area.lte(b.maxArea));
      if (!band) issue("band", `${p.sku} 没有匹配的尺寸档位`, "admin", true, line.key);
      else { cost = d(band.cost); sale = d(band.sale); }
    }
    if (["material", "composite"].includes(p.pricing)) {
      if (!p.formula.length) issue("formula", `${p.sku} 缺少构成公式`, "admin", true, line.key);
      cost = sum(p.formula.map(t => bases[t.basis].mul(t.coefficient).mul(t.cost)));
      sale = sum(p.formula.map(t => bases[t.basis].mul(t.coefficient).mul(t.sale)));
    }
    const selected = p.options.filter(o => line.options.includes(o.id));
    if (new Set(line.options).size !== line.options.length || selected.length !== line.options.length || p.options.some(o => o.required && !line.options.includes(o.id))) issue("options", `${p.sku} 配置选项无效或缺少必选项`, "admin", true, line.key);
    for (const o of selected) {
      if (o.cost === null || o.sale === null) issue("option-price", `${p.sku}/${o.nameZh} 未核价`, "admin", true, line.key);
      cost = cost.plus(bases[o.basis].mul(o.cost || 0)); sale = sale.plus(bases[o.basis].mul(o.sale || 0)); minimum = minimum.plus(bases[o.basis].mul(o.cost || 0));
    }
    // Unpriced free text never silently changes a standard configuration.
    if (Object.entries(line.specs).some(([k, v]) => v && v !== p.standardSpecs[k])) { issue("specification", `${p.sku} 参数偏离标准配置，需技术与价格审批`, "technical", false, line.key); issue("specification-price", `${p.sku} 额外参数需核价`, "admin", false, line.key); }
    if (line.unitPrice !== null && !permission.canAdjustUnitPrice) issue("override", `${p.sku} 手动单价超出员工权限，须管理员审批`, "admin", false, line.key);
    if (line.discountPct > permission.maxDiscountPct) issue("discount", `${p.sku} 折扣超过权限`, "admin", false, line.key);
    const unitPrice = round((line.unitPrice === null ? convert(sale) : d(line.unitPrice)).mul(d(1).minus(d(line.discountPct).div(100))));
    if (d(unitPrice).lt(convert(minimum))) issue("minimum", `${p.sku} 低于最低销售价`, "admin", false, line.key);
    const pk = p.packing, packages = Math.ceil(line.quantity / pk.unitsPerPackage);
    if (!pk.configured || !pk.depthMm || [pk.kgPerSqm, pk.fixedKg, pk.tareKg, pk.costPerPackage, pk.salePerPackage].some(v => v === null)) issue("packing", `${p.sku} 包装/重量/费用规则未完整配置`, "logistics", true, line.key);
    const pw = width.plus(pk.widthAllowanceMm), ph = height.plus(pk.heightAllowanceMm), net = area.mul(pk.kgPerSqm || 0).plus(pk.fixedKg || 0).mul(line.quantity), gross = net.plus(d(pk.tareKg || 0).mul(packages));
    const packed: Packed = { packages, cbm: round(pw.mul(ph).mul(pk.depthMm).div(1e9).mul(packages), 6), netKg: round(net), grossKg: round(gross), widthMm: pw.toNumber(), heightMm: ph.toNumber(), depthMm: pk.depthMm, type: pk.type, fragile: pk.fragile, fumigation: pk.fumigation, stackable: pk.stackable };
    if ((pk.maxPieceKg !== null && gross.div(packages).gt(pk.maxPieceKg)) || (pk.maxLengthMm !== null && Decimal.max(pw, ph, pk.depthMm).gt(pk.maxLengthMm))) issue("oversize", `${p.sku} 超大/超重包装需物流确认`, "logistics", false, line.key);
    const productTotal = round(d(unitPrice).mul(line.quantity)), packingTotal = round(convert(d(pk.salePerPackage || 0).mul(packages))), lineCost = cost.mul(line.quantity).plus(d(pk.costPerPackage || 0).mul(packages));
    totalCost = totalCost.plus(lineCost);
    const sellCny = d(productTotal).plus(packingTotal).mul(quoteFx.cnyPerUnit), marginPct = sellCny.gt(0) ? sellCny.minus(lineCost).div(sellCny).mul(100).toNumber() : -100;
    if (marginPct < Math.max(settings.minMarginPct, permission.minMarginPct)) issue("line-margin", `${p.sku} 低于最低毛利要求`, "admin", false, line.key);
    return [{ key: line.key, sku: p.sku, nameZh: p.nameZh, nameEn: p.nameEn, widthMm: width.toNumber(), heightMm: height.toNumber(), area: round(area, 6), billedArea: round(billedArea, 6), quantity: line.quantity, unitPrice, productTotal, packingTotal, packed, svg: drawProduct(line, p, width.toNumber(), height.toNumber()), specs: { ...p.standardSpecs, ...line.specs }, options: selected.map(o => `${o.nameZh} / ${o.nameEn}`), location: [line.location, line.floor, line.room, line.openingNumber].filter(Boolean).join(" / "), special: line.special, private: { cost: round(lineCost), minimum: round(convert(minimum)), marginPct: round(marginPct), product: p } }];
  });
  const cbm = round(sum(lines.map(l => l.packed.cbm)), 6), grossKg = round(sum(lines.map(l => l.packed.grossKg))), netKg = round(sum(lines.map(l => l.packed.netKg))), packages = lines.reduce((a, l) => a + l.packed.packages, 0);
  const containers = settings.containers.filter(c => cbm <= c.cbm && grossKg <= c.kg && lines.every(l => {
    const item = [l.packed.widthMm, l.packed.heightMm, l.packed.depthMm].sort((a, b) => a - b), box = [c.lengthMm, c.widthMm, c.heightMm].sort((a, b) => a - b); return item.every((v, i) => v <= box[i]);
  })).map(c => c.name);
  const required: Record<QuoteInput["incoterm"], string[]> = { EXW: [], FCA: settings.fcaFees, FOB: ["domestic", "export"], CFR: ["domestic", "export", "international"], CIF: ["domestic", "export", "international", "insurance"], DAP: ["domestic", "export", "international", "destination", "delivery"], DDP: ["domestic", "export", "international", "destination", "delivery", "customs", "duty"] };
  if (input.incoterm === "FCA" && !settings.fcaConfigured) issue("fca", "FCA 交货地点和费用范围尚未由管理员确认", "logistics");
  if (input.customerForwarder && !["EXW", "FOB", "FCA"].includes(input.incoterm)) issue("forwarder", "该贸易条款不能以客户自付运费跳过卖方运输义务", "logistics");
  let freightCost: Decimal | null = d(0), freightTotal: number | null = 0;
  if (required[input.incoterm].length) {
    const valid = freight?.active && freight.country.toLowerCase() === input.country.toLowerCase() && (!freight.city || freight.city.toLowerCase() === input.city.toLowerCase()) && freight.originPort === input.originPort && freight.destinationPort === input.destinationPort && freight.mode === input.freightMode && (!freight.projectId || freight.projectId === projectId) && freight.validFrom <= today && freight.validUntil >= today && freight.validUntil >= input.targetDate && freight.validUntil >= input.validUntil;
    if (!valid || !freight) { issue("freight", "缺少匹配路线且覆盖有效期及发货日的真实运价，不能按零运费出单", "logistics"); freightCost = null; freightTotal = null; }
    else {
      expiry.push(freight.validUntil);
      if (required[input.incoterm].some(k => !freight.confirmed.includes(k as typeof freight.confirmed[number]) || !freight.fees.some(f => f.kind === k))) { issue("coverage", `${input.incoterm} 所需费用尚未逐项核实（DDP 必须确认清关与税费）`, "logistics"); freightCost = null; freightTotal = null; }
      else {
        if (freight.fees.some(f => f.basis === "chargeableKg") && !freight.volumetricKgPerCbm) issue("volumetric", "空运/快递计费体积重系数未配置", "logistics");
        if (freight.mode === "FCL" && !containers.includes(freight.container)) issue("container", "整柜规格未配置或单柜估算无法容纳，需拆分/重新核价", "logistics");
        const measure = { fixed: d(1), cbm: d(cbm), kg: d(grossKg), chargeableKg: Decimal.max(grossKg, d(cbm).mul(freight.volumetricKgPerCbm)), container: d(1) };
        const feeSum = sum(freight.fees.filter(f => required[input.incoterm].includes(f.kind) || f.kind === "other").map(f => Decimal.max(measure[f.basis].mul(f.rate), f.minimum)));
        freightCost = feeSum.mul(fx(freight.currency).cnyPerUnit); freightTotal = round(convert(freightCost).mul(d(1).plus(d(input.freightMarkupPct).div(100))));
        totalCost = totalCost.plus(freightCost);
      }
    }
  }
  const productTotal = round(sum(lines.map(l => l.productTotal))), packingTotal = round(sum(lines.map(l => l.packingTotal))), total = freightTotal === null ? null : round(sum([productTotal, packingTotal, freightTotal]));
  const sellCny = d(total || 0).mul(quoteFx.cnyPerUnit), marginPct = total === null ? null : sellCny.gt(0) ? round(sellCny.minus(totalCost).div(sellCny).mul(100)) : -100;
  if (marginPct !== null && marginPct < Math.max(settings.minMarginPct, permission.minMarginPct)) issue("margin", "整单低于最低毛利要求", "admin", false);
  return { lines, issues, currency: input.currency, productTotal, packingTotal, freightTotal, total, packages, cbm, netKg, grossKg, containers, validThrough: expiry.sort()[0], private: { costCny: round(totalCost), marginPct, freightCostCny: freightCost === null ? null : round(freightCost), freight, settings, fx: quoteFx, policy: permission } };
}
