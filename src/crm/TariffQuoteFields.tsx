import { Link } from "react-router-dom";
import type { QuoteInput } from "../../shared/quoting.ts";
import type { TariffRecord } from "../../shared/tariffs.ts";
import { useResource } from "./api.ts";
import { Field, Panel, ErrorBox } from "./ui.tsx";
export function TariffQuoteFields({
  value: q,
  onChange,
  disabled,
}: {
  value: QuoteInput;
  onChange: (q: QuoteInput) => void;
  disabled: boolean;
}) {
  const ctx = q.tariff || {
    destination: "",
    origin: "",
    applicableOn: q.targetDate,
    calculationBasis: "",
  };
  const r = useResource<{ records: TariffRecord[]; total: number }>(
    `/tariffs?country=${ctx.destination}&origin=${ctx.origin}&review=verified`,
  );
  if (!["CIF", "DAP", "DDP"].includes(q.incoterm)) return null;
  return (
    <Panel title="税率依据 · G-37">
      <p>
        从已人工核定的完整国家税则中选择，每种材质及零配件分别核定。
        <Link to="/tariffs" target="_blank">
          打开海关税率与来源 ↗
        </Link>
      </p>
      <fieldset disabled={disabled}>
        <div className="form-grid">
          {(
            [
              ["destination", "目的国两位代码（与上方国家一致）"],
              ["origin", "原产地两位代码"],
              ["applicableOn", "适用日期（与目标出运日一致）"],
              ["calculationBasis", "费用承担和计算依据（至少10字）"],
            ] as const
          ).map(([k, label]) => (
            <Field key={k} label={label}>
              <input
                type={k === "applicableOn" ? "date" : "text"}
                value={ctx[k]}
                onChange={(e) =>
                  onChange({
                    ...q,
                    tariff: {
                      ...ctx,
                      [k]: ["destination", "origin"].includes(k)
                        ? e.target.value.toUpperCase()
                        : e.target.value,
                    },
                  })
                }
              />
            </Field>
          ))}
        </div>
        {q.lines.map((l, i) => (
          <div className="tariff-line" key={l.key}>
            <strong>
              第{i + 1}项 · 产品编号 {l.productId}
            </strong>
            <Field label="目的国完整HS编码">
              <input
                value={l.tariffHsCode || ""}
                onChange={(e) =>
                  onChange({
                    ...q,
                    lines: q.lines.map((x) =>
                      x.key === l.key
                        ? {
                            ...x,
                            tariffHsCode: e.target.value || undefined,
                            tariffRateIds: [],
                          }
                        : x,
                    ),
                  })
                }
              />
            </Field>
            {r.data?.records
              .filter((x) => !x.reference_only && x.hs_code === l.tariffHsCode)
              .map((x) => (
                <label key={x.id}>
                  <input
                    type="checkbox"
                    checked={l.tariffRateIds?.includes(x.id) || false}
                    onChange={(e) =>
                      onChange({
                        ...q,
                        lines: q.lines.map((a) =>
                          a.key === l.key
                            ? {
                                ...a,
                                tariffRateIds: e.target.checked
                                  ? [...(a.tariffRateIds || []), x.id]
                                  : (a.tariffRateIds || []).filter(
                                      (id) => id !== x.id,
                                    ),
                              }
                            : a,
                        ),
                      })
                    }
                  />
                  {x.tax_kind} · {x.rate_text} · V{x.version} · {x.source_name}{" "}
                  · {x.warning || "已复核"}
                </label>
              ))}
            {!r.data?.records.some(
              (x) => !x.reference_only && x.hs_code === l.tariffHsCode,
            ) && <p>暂无匹配的已核定税率，请管理员先录入、复核。</p>}
          </div>
        ))}
        <ErrorBox message={r.error} />
        <p className="muted">
          不会自动计税或改动已核实运价；DDP须分别核验进口VAT、关税及附加条件，并核实费用已包含。出口退税不抵扣进口税。历史已签发报价只读保存。
        </p>
      </fieldset>
    </Panel>
  );
}
