import { useState } from "react";
import {
  categories,
  methods,
  basis,
  specLabels,
} from "../../shared/quoting.ts";
import {
  factoryProductSchema,
  factoryRuleSchema,
  factoryReadiness,
  pricingLabels,
  basisLabels,
  type FactoryProduct,
  type FactoryProductInput,
  type FactoryRule,
} from "../../shared/factory.ts";
import { useMutation } from "./api.ts";
import { useSession } from "./context.tsx";
import { ErrorBox, Field } from "./ui.tsx";
import { NumberField } from "./NumberField.tsx";

function productInput(p?: FactoryProduct): FactoryProductInput {
  return p
    ? factoryProductSchema.parse({
        sku: p.sku,
        nameZh: p.name_zh,
        nameEn: p.name_en,
        category: p.category,
        series: p.series,
        specification: p.specification,
        supplyPrice: Number(p.supply_price),
        currency: p.currency,
        pricingMethod: p.pricing_method,
        pricingRule: p.pricing_rule,
        leadDays: p.lead_days,
        imageUrls: p.image_urls,
        imageIds: p.image_ids,
        version: p.version,
      })
    : {
        sku: "",
        nameZh: "",
        nameEn: "",
        category: "推拉门",
        series: "",
        specification: "",
        supplyPrice: 0,
        currency: "CNY",
        pricingMethod: "area_options",
        pricingRule: factoryRuleSchema.parse({}),
        leadDays: 30,
        imageUrls: [],
        imageIds: [],
      };
}
const drawingLabels = {
  casement: "平开",
  sliding: "推拉",
  folding: "折叠",
  pivot: "转轴",
  fixed: "固定",
  custom: "定制（需技术图纸）",
};
export function FactoryProductEditor({
  product,
  close,
}: {
  product?: FactoryProduct;
  close: () => void;
}) {
  const { refresh, notify } = useSession(),
    m = useMutation();
  const [form, setForm] = useState(() => productInput(product));
  const set = <K extends keyof FactoryProductInput>(
    key: K,
    value: FactoryProductInput[K],
  ) => setForm((f) => ({ ...f, [key]: value }));
  const rule = form.pricingRule;
  const setRule = <K extends keyof FactoryRule>(
    key: K,
    value: FactoryRule[K],
  ) =>
    setForm((f) => ({ ...f, pricingRule: { ...f.pricingRule, [key]: value } }));
  const pack = rule.packing;
  const setPack = <K extends keyof FactoryRule["packing"]>(
    key: K,
    value: FactoryRule["packing"][K],
  ) => setRule("packing", { ...pack, [key]: value });
  const issues = factoryReadiness(rule, form.pricingMethod);
  const save = () => {
    const parsed = factoryProductSchema.safeParse(form);
    if (!parsed.success) {
      m.setError(parsed.error.issues.map((i) => i.message).join("；"));
      return;
    }
    void m.run(
      `/supply/factory-products${product ? `/${product.id}` : ""}`,
      product ? "PUT" : "POST",
      parsed.data,
      () => {
        notify("草稿已保存。图片可在产品卡片上传，全部核对后提交审核。");
        close();
        refresh();
      },
    );
  };
  return (
    <form
      className="factory-editor"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <fieldset disabled={m.busy} className="quote-fieldset">
        <div className="form-grid">
          <Field label="产品编号 *">
            <input
              required
              maxLength={80}
              value={form.sku}
              onChange={(e) => set("sku", e.target.value)}
            />
          </Field>
          <Field label="中文名称 *">
            <input
              required
              maxLength={200}
              value={form.nameZh}
              onChange={(e) => set("nameZh", e.target.value)}
            />
          </Field>
          <Field label="英文名称">
            <input
              value={form.nameEn}
              onChange={(e) => set("nameEn", e.target.value)}
            />
          </Field>
          <Field label="产品类别">
            <select
              value={form.category}
              onChange={(e) =>
                set(
                  "category",
                  e.target.value as FactoryProductInput["category"],
                )
              }
            >
              {categories.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
          <Field label="系列">
            <input
              value={form.series}
              onChange={(e) => set("series", e.target.value)}
            />
          </Field>
          <NumberField
            label="基础供货价（人民币）"
            value={form.supplyPrice}
            onChange={(v) => set("supplyPrice", v ?? 0)}
          />
          <Field label="计价方式">
            <select
              value={form.pricingMethod}
              onChange={(e) =>
                set(
                  "pricingMethod",
                  e.target.value as FactoryProductInput["pricingMethod"],
                )
              }
            >
              {methods.map((v) => (
                <option key={v} value={v}>
                  {pricingLabels[v]}
                </option>
              ))}
            </select>
          </Field>
          <NumberField
            label="常规交期（天）"
            value={form.leadDays}
            step="1"
            onChange={(v) => set("leadDays", v ?? 0)}
          />
          <Field label="供货价有效期">
            <input
              type="date"
              value={rule.priceValidUntil ?? ""}
              onChange={(e) =>
                setRule("priceValidUntil", e.target.value || null)
              }
            />
          </Field>
          <Field label="示意图类型">
            <select
              value={rule.drawing}
              onChange={(e) =>
                setRule("drawing", e.target.value as FactoryRule["drawing"])
              }
            >
              {Object.entries(drawingLabels).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="规格说明" wide>
            <textarea
              value={form.specification}
              onChange={(e) => set("specification", e.target.value)}
            />
          </Field>
        </div>
        <details open>
          <summary>尺寸与计价规则</summary>
          <div className="form-grid">
            {(
              [
                ["minWidthMm", "最小宽度 mm"],
                ["maxWidthMm", "最大宽度 mm"],
                ["minHeightMm", "最小高度 mm"],
                ["maxHeightMm", "最大高度 mm"],
                ["minArea", "最低计费面积 ㎡"],
              ] as const
            ).map(([key, label]) => (
              <NumberField
                key={key}
                label={label}
                value={rule[key]}
                onChange={(v) => setRule(key, v ?? 0)}
              />
            ))}
            {form.pricingMethod === "linear" && (
              <Field label="延米计算依据">
                <select
                  value={rule.linearBasis}
                  onChange={(e) =>
                    setRule(
                      "linearBasis",
                      e.target.value as FactoryRule["linearBasis"],
                    )
                  }
                >
                  {["width", "height", "perimeter"].map((v) => (
                    <option key={v} value={v}>
                      {basisLabels[v]}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <p className="quote-help">
            基础供货价按所选单位计算；固定总价是整行总价。面积档位按单件实际面积选档，材料/组合按各项系数合计。公司销售价由公司单独审核设置。
          </p>
          {form.pricingMethod === "range" && (
            <>
              <h4>面积档位</h4>
              {rule.bands.map((b, i) => (
                <div className="factory-rule-row" key={i}>
                  <NumberField
                    label={`档位${i + 1} 面积上限㎡`}
                    value={b.maxArea}
                    onChange={(v) =>
                      setRule(
                        "bands",
                        rule.bands.map((r, n) =>
                          n === i ? { ...r, maxArea: v ?? 0 } : r,
                        ),
                      )
                    }
                  />
                  <NumberField
                    label={`档位${i + 1} 每件供货价`}
                    value={b.cost}
                    onChange={(v) =>
                      setRule(
                        "bands",
                        rule.bands.map((r, n) =>
                          n === i ? { ...r, cost: v ?? 0 } : r,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setRule(
                        "bands",
                        rule.bands.filter((_, n) => n !== i),
                      )
                    }
                  >
                    移除档位{i + 1}
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setRule("bands", [
                    ...rule.bands,
                    { maxArea: (rule.bands.at(-1)?.maxArea ?? 0) + 1, cost: 0 },
                  ])
                }
              >
                ＋ 添加面积档位
              </button>
            </>
          )}
          {["material", "composite"].includes(form.pricingMethod) && (
            <>
              <h4>构成项</h4>
              {rule.formula.map((f, i) => (
                <div className="factory-rule-row" key={i}>
                  <Field label={`构成${i + 1} 名称`}>
                    <input
                      value={f.name}
                      onChange={(e) =>
                        setRule(
                          "formula",
                          rule.formula.map((r, n) =>
                            n === i ? { ...r, name: e.target.value } : r,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field label={`构成${i + 1} 计算依据`}>
                    <select
                      value={f.basis}
                      onChange={(e) =>
                        setRule(
                          "formula",
                          rule.formula.map((r, n) =>
                            n === i
                              ? {
                                  ...r,
                                  basis: e.target.value as typeof f.basis,
                                }
                              : r,
                          ),
                        )
                      }
                    >
                      {basis.map((v) => (
                        <option key={v} value={v}>
                          {basisLabels[v]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <NumberField
                    label={`构成${i + 1} 系数`}
                    value={f.coefficient}
                    onChange={(v) =>
                      setRule(
                        "formula",
                        rule.formula.map((r, n) =>
                          n === i ? { ...r, coefficient: v ?? 0 } : r,
                        ),
                      )
                    }
                  />
                  <NumberField
                    label={`构成${i + 1} 成本单价`}
                    value={f.cost}
                    onChange={(v) =>
                      setRule(
                        "formula",
                        rule.formula.map((r, n) =>
                          n === i ? { ...r, cost: v ?? 0 } : r,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setRule(
                        "formula",
                        rule.formula.filter((_, n) => n !== i),
                      )
                    }
                  >
                    移除构成{i + 1}
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setRule("formula", [
                    ...rule.formula,
                    { name: "", basis: "area", coefficient: 1, cost: 0 },
                  ])
                }
              >
                ＋ 添加构成项
              </button>
            </>
          )}
        </details>
        <details>
          <summary>标准规格（报价单及生产配置）</summary>
          <div className="form-grid">
            {Object.entries({
              ...specLabels,
              ...Object.fromEntries(
                Object.keys(rule.standardSpecs)
                  .filter((k) => !specLabels[k])
                  .map((k) => [k, k]),
              ),
            }).map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  maxLength={500}
                  value={rule.standardSpecs[key] ?? ""}
                  onChange={(e) =>
                    setRule("standardSpecs", {
                      ...rule.standardSpecs,
                      [key]: e.target.value,
                    })
                  }
                />
              </Field>
            ))}
          </div>
        </details>
        <details>
          <summary>选配与加价成本（{rule.options.length}项）</summary>
          {rule.options.map((o, i) => (
            <div className="factory-rule-row" key={o.id}>
              <Field label={`选配${i + 1} 名称`}>
                <input
                  value={o.nameZh}
                  onChange={(e) =>
                    setRule(
                      "options",
                      rule.options.map((r, n) =>
                        n === i ? { ...r, nameZh: e.target.value } : r,
                      ),
                    )
                  }
                />
              </Field>
              <Field label={`选配${i + 1} 英文名称`}>
                <input
                  value={o.nameEn}
                  onChange={(e) =>
                    setRule(
                      "options",
                      rule.options.map((r, n) =>
                        n === i ? { ...r, nameEn: e.target.value } : r,
                      ),
                    )
                  }
                />
              </Field>
              <Field label={`选配${i + 1} 分组`}>
                <input
                  value={o.group}
                  onChange={(e) =>
                    setRule(
                      "options",
                      rule.options.map((r, n) =>
                        n === i ? { ...r, group: e.target.value } : r,
                      ),
                    )
                  }
                />
              </Field>
              <Field label={`选配${i + 1} 计算依据`}>
                <select
                  value={o.basis}
                  onChange={(e) =>
                    setRule(
                      "options",
                      rule.options.map((r, n) =>
                        n === i
                          ? { ...r, basis: e.target.value as typeof o.basis }
                          : r,
                      ),
                    )
                  }
                >
                  {basis.map((v) => (
                    <option key={v} value={v}>
                      {basisLabels[v]}
                    </option>
                  ))}
                </select>
              </Field>
              <NumberField
                label={`选配${i + 1} 供货成本`}
                nullable
                value={o.cost}
                onChange={(v) =>
                  setRule(
                    "options",
                    rule.options.map((r, n) =>
                      n === i ? { ...r, cost: v } : r,
                    ),
                  )
                }
              />
              <label className="factory-check">
                <input
                  type="checkbox"
                  checked={o.required}
                  onChange={(e) =>
                    setRule(
                      "options",
                      rule.options.map((r, n) =>
                        n === i ? { ...r, required: e.target.checked } : r,
                      ),
                    )
                  }
                />
                必选项
              </label>
              <button
                type="button"
                onClick={() =>
                  setRule(
                    "options",
                    rule.options.filter((_, n) => n !== i),
                  )
                }
              >
                移除选配{i + 1}
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setRule("options", [
                ...rule.options,
                {
                  id: crypto.randomUUID(),
                  nameZh: "新选配",
                  nameEn: "",
                  group: "",
                  basis: "one",
                  cost: null,
                  required: false,
                },
              ])
            }
          >
            ＋ 添加选配
          </button>
        </details>
        <details open>
          <summary>包装与物流参数</summary>
          <label className="factory-check">
            <input
              type="checkbox"
              checked={pack.configured}
              onChange={(e) => setPack("configured", e.target.checked)}
            />
            已核对本产品包装规则
          </label>
          <div className="form-grid">
            <Field label="包装类型">
              <input
                value={pack.type}
                onChange={(e) => setPack("type", e.target.value)}
              />
            </Field>
            {(
              [
                ["widthAllowanceMm", "包装宽度余量 mm"],
                ["heightAllowanceMm", "包装高度余量 mm"],
                ["depthMm", "包装厚度 mm"],
                ["unitsPerPackage", "每包件数"],
                ["kgPerSqm", "每㎡净重 kg"],
                ["fixedKg", "每件固定净重 kg"],
                ["tareKg", "每包包装自重 kg"],
                ["costPerPackage", "每包包装成本 CNY"],
                ["maxPieceKg", "单件重量上限 kg（可空）"],
                ["maxLengthMm", "长度上限 mm（可空）"],
              ] as const
            ).map(([key, label]) => (
              <NumberField
                key={key}
                label={label}
                value={pack[key]}
                nullable={
                  ![
                    "widthAllowanceMm",
                    "heightAllowanceMm",
                    "depthMm",
                    "unitsPerPackage",
                  ].includes(key)
                }
                min={key === "unitsPerPackage" ? 1 : 0}
                step={key === "unitsPerPackage" ? "1" : "any"}
                onChange={(v) =>
                  key === "widthAllowanceMm" ||
                  key === "heightAllowanceMm" ||
                  key === "depthMm" ||
                  key === "unitsPerPackage"
                    ? setPack(key, v ?? 0)
                    : setPack(key, v)
                }
              />
            ))}
          </div>
          <div className="quote-options">
            {(
              [
                ["fragile", "易碎"],
                ["fumigation", "需要熏蒸"],
                ["stackable", "可堆叠"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={pack[key]}
                  onChange={(e) => setPack(key, e.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>
        </details>
        {!!form.imageIds.length && (
          <div className="factory-images">
            {form.imageIds.map((id, i) => (
              <figure key={id}>
                <img
                  src={`/api/supply/factory-product-images/${id}`}
                  alt={`${form.nameZh} 产品图${i + 1}`}
                  loading="lazy"
                />
                <button
                  type="button"
                  onClick={() =>
                    set(
                      "imageIds",
                      form.imageIds.filter((v) => v !== id),
                    )
                  }
                >
                  移除图片{i + 1}
                </button>
              </figure>
            ))}
          </div>
        )}
        <p className="quote-help">
          先保存草稿，再在产品卡片上传图片。修改已发布产品需要重新审核，原销售目录在新版本审核通过前不变。
        </p>
        {!!issues.length && (
          <p className="notice">
            可先保存草稿，提交审核前需补齐：{issues.join("；")}
          </p>
        )}
        <ErrorBox message={m.error} />
        <div className="actions">
          <button className="primary" type="submit">
            {m.busy ? "正在保存…" : "保存草稿"}
          </button>
          <button type="button" onClick={close}>
            取消
          </button>
        </div>
      </fieldset>
    </form>
  );
}
