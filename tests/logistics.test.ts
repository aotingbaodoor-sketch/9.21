import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixtures, today, future } from "./quoting.fixtures.ts";
import {
  calculate,
  policy,
  publicCalculation,
} from "../server/quoting/engine.ts";
import {
  applyLogistics,
  insurancePremium,
} from "../server/logistics/engine.ts";
import {
  rateSchema,
  activeTerms,
  stageApplicable,
  type CostRate,
} from "../shared/logistics.ts";
import { parseFxBackup } from "../server/pricing/sync.ts";
const actor = { id: randomUUID(), role: "admin" };
function setup(term: (typeof activeTerms)[number]) {
  const f = fixtures();
  f.input.incoterm = term;
  f.input.currency = "CNY";
  f.input.freightId = null;
  f.input.country = "US";
  f.input.lines[0].unitPrice = 2000;
  f.settings.minMarginPct = 0;
  f.settings.defaultPolicy.minMarginPct = 0;
  f.input.logistics = {
    rateIds: [],
    transport: "sea",
    containers: 1,
    storageDays: 3,
    includedServices: [],
    scope: "ISOLATED TEST contractual seller scope only",
  };
  const required = {
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
  }[term];
  const rates: CostRate[] = required.map((kind, index) => {
    const id = randomUUID(),
      taxId = ["duty", "vat"].includes(kind) ? randomUUID() : null;
    return {
      ...rateSchema.parse({
        name: `TEST ${kind}`,
        kind,
        country: "US",
        currency: "CNY",
        unit: kind === "insurance" || taxId ? "percent" : "fixed",
        rate: kind === "insurance" ? 0.3 : taxId ? 5 : 100,
        minimum: 0,
        validFrom: today,
        validUntil: future,
        sourceDate: today,
        provider: "ISOLATED TEST",
        evidence: "https://example.invalid/isolated",
        scope: "ISOLATED TEST approved assumptions",
        tariffId: taxId,
        taxBase: taxId ? ["goods"] : [],
        priorTaxes: [],
      }),
      id,
      series_id: randomUUID(),
      version: index + 1,
      is_current: true,
    };
  });
  f.input.logistics.rateIds = rates.map((r) => r.id);
  f.input.lines[0].tariffRateIds = rates
    .filter((r) => r.tariffId)
    .map((r) => r.tariffId!);
  if (term === "DDP")
    f.input.logistics.ddp = {
      clearingParty: "TEST importer",
      qualificationEvidence: "https://example.invalid/qualified",
      qualificationConfirmed: true,
      taxCap: 2000,
      boundary: "TEST contractual caps and service exclusions",
      riskPct: 20,
      riskBase: "full_cost",
      riskReason: "TEST explicit risk basis to approve",
    };
  const base = () => {
    const c = calculate(
      f.input,
      [f.product],
      null,
      f.settings,
      policy(f.settings, actor),
      today,
      randomUUID(),
      true,
    );
    c.tariffBasis = {
      required: term === "DDP",
      errors: [],
      records: rates
        .filter((r) => r.tariffId)
        .map((r) => ({
          id: r.tariffId,
          tax_kind: r.kind,
          rate_text: "5%",
          verification: "verified",
          hs_code: "7610100010",
        })) as never,
    };
    return c;
  };
  return {
    f,
    rates,
    base,
    run: () => applyLogistics(base(), f.input, rates, f.settings, today),
  };
}
test("five actual calculation paths keep costs and sale prices distinct, quantities included", () => {
  for (const term of activeTerms) {
    const { run } = setup(term),
      c = run(),
      s = c.private.logistics!;
    assert.equal(
      c.issues.filter((i) => i.hard).length,
      0,
      JSON.stringify(c.issues),
    );
    assert.notEqual(s.goodsCostCny, c.productTotal);
    assert.equal(c.total, c.productTotal + c.packingTotal + c.freightTotal!);
    assert.ok(s.costCny >= s.goodsCostCny);
    assert.equal(s.ruleVersion, "logistics-1.1");
    console.log(
      "EXAMPLE",
      term,
      JSON.stringify({
        goodsCost: s.goodsCostCny,
        actualCost: s.costCny,
        sale: c.total,
        floor: s.floorCny,
        risk: s.riskCny,
        components: s.components,
      }),
    );
  }
});
test("110% insurance closed-form, minimum premium, per-mille and invalid denominator", () => {
  assert.equal(insurancePremium(10000, 0.3, "percent", 0), 33.11);
  assert.equal(insurancePremium(10000, 3, "permille", 0), 33.11);
  assert.equal(insurancePremium(100, 0.3, "percent", 20), 20);
  assert.throws(() => insurancePremium(100, 100, "percent", 0));
});
test("G31 required cost missing / duplicate / unit conditions, G32 expiry", () => {
  let t = setup("FOB");
  t.rates.pop();
  assert.equal(t.run().total, null);
  t = setup("FOB");
  t.rates.push({ ...t.rates[0], id: randomUUID() });
  assert.ok(t.run().issues.some((r) => r.code === "G-31"));
  t = setup("FOB");
  t.rates[0].validUntil = "2000-01-01";
  assert.ok(t.run().issues.some((r) => r.code === "G-32"));
  t = setup("FOB");
  t.rates[0].country = "JP";
  assert.ok(t.run().issues.some((r) => r.code === "G-31"));
});
test("G33 CIF waterway vs air, G34 clearing party, G35 cost hard gate even admin", () => {
  const t = setup("CIF");
  t.f.input.freightMode = "air";
  t.f.input.logistics!.transport = "air";
  assert.ok(t.run().issues.some((r) => r.code === "G-33"));
  const d = setup("DDP");
  delete d.f.input.logistics!.ddp;
  assert.ok(d.run().issues.some((r) => r.code === "G-34"));
  const x = setup("EXW");
  x.f.input.lines[0].unitPrice = 1;
  assert.equal(x.run().total, null);
  assert.ok(x.run().issues.some((r) => r.code === "G-35" && r.hard));
});
test("G36 obsolete cost and G37 tax source mismatch / dependency cycles fail closed", () => {
  const t = setup("DDP");
  t.rates[0].is_current = false;
  assert.ok(t.run().issues.some((r) => r.code === "G-36"));
  const vat = t.rates.find((r) => r.kind === "vat")!,
    duty = t.rates.find((r) => r.kind === "duty")!;
  vat.priorTaxes = [duty.id];
  duty.priorTaxes = [vat.id];
  assert.equal(t.run().total, null);
  assert.ok(t.run().issues.some((r) => r.code === "G-37"));
  const clean = setup("DDP"),
    c = clean.base();
  c.tariffBasis!.records[0].verification = "pending";
  assert.equal(
    applyLogistics(c, clean.f.input, clean.rates, clean.f.settings, today)
      .total,
    null,
  );
});
test("VAT base includes preceding duty once, not simple addition; private costs withheld", () => {
  const t = setup("DDP");
  const vat = t.rates.find((r) => r.kind === "vat")!,
    duty = t.rates.find((r) => r.kind === "duty")!;
  vat.priorTaxes = [duty.id];
  const c = t.run(),
    s = c.private.logistics!;
  assert.equal(s.components.find((r) => r.kind === "duty")?.costCny, 321);
  assert.equal(s.components.find((r) => r.kind === "vat")?.costCny, 337.05);
  const out = JSON.stringify(
    publicCalculation(c, {
      ...t.f.settings.defaultPolicy,
      viewCosts: false,
      viewFreightCost: false,
    }),
  );
  for (const forbidden of [
    "goodsCostCny",
    "floorCny",
    "riskCny",
    "private",
    "costCny",
    "profitCny",
    "qualificationEvidence",
  ])
    assert.ok(!out.includes(forbidden), forbidden);
});
test("22x5 applicability preserves EXW pickup and only excludes loaded/export", () => {
  const stages = [
    "deposit_confirmed",
    "wo_issued",
    "po_issued",
    "material_ready",
    "in_production",
    "sample_approved",
    "production_done",
    "packed",
    "shipment_checked",
    "forwarder_assigned",
    "picked_up",
    "loaded",
    "export_cleared",
    "shipped",
    "departed",
    "arrived",
    "dest_cleared",
    "balance_settled",
    "delivered",
    "accepted",
    "warranty_started",
    "closed",
  ];
  assert.equal(stages.length, 22);
  for (const term of activeTerms)
    assert.equal(
      stages.filter((s) => stageApplicable(s, term)).length,
      term === "EXW" ? 20 : 22,
    );
});
test("backup FX conversion validates direction, dates and currencies", () => {
  const rows = Array.from({ length: 22 }, (_, i) => ({
    date: today,
    base: "EUR",
    quote: [
      "USD",
      "CNY",
      ...Array.from(
        { length: 20 },
        (_, j) => `X${String.fromCharCode(65 + j)}Z`,
      ),
    ][i],
    rate: i === 0 ? 1.2 : i === 1 ? 8.4 : 2,
  }));
  const r = parseFxBackup(JSON.stringify(rows));
  assert.equal(r.cnyRates.USD, 7);
  assert.equal(r.cnyRates.EUR, 8.4);
  assert.throws(() => parseFxBackup("<html>login</html>"));
  assert.throws(() => parseFxBackup(JSON.stringify([...rows, rows[0]])));
});
test("insurance accounts for the existing company FX buffer without a second freight margin", () => {
  const base = 1000, r = 0.3 / 100, buffer = 1.02;
  const premium = insurancePremium(base, 0.3, "percent", 0, buffer);
  assert.ok(Math.abs(premium - (base + premium * buffer) * 1.1 * r) < 0.01);
  assert.throws(() => insurancePremium(base, 90, "percent", 0, 1.1));
});
