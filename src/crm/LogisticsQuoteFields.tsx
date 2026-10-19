import { Link } from "react-router-dom";
import { useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { Panel, Field, ErrorBox } from "./ui.tsx";
import {
  chargeLabels,
  type CostRate,
  type LogisticsInput,
} from "../../shared/logistics.ts";
import type { QuoteInput } from "../../shared/quoting.ts";
export function LogisticsQuoteFields({
  value,
  onChange,
  disabled,
  quoteId,
}: {
  value: QuoteInput;
  onChange: (v: QuoteInput) => void;
  disabled: boolean;
  quoteId?: string;
}) {
  const { user, revision } = useSession(),
    r = useResource<(CostRate & { status: string })[]>(
      "/logistics/rates",
      revision,
    );
  const current = value.logistics,
    base: LogisticsInput = current ?? {
      rateIds: [],
      transport: ["LCL", "FCL"].includes(value.freightMode)
        ? "sea"
        : ["air", "courier"].includes(value.freightMode)
          ? "air"
          : value.freightMode === "rail"
            ? "rail"
            : value.freightMode === "truck"
              ? "road"
              : "multimodal",
      containers: 1,
      storageDays: 0,
      includedServices: [],
      scope: "",
    };
  const update = (next: Partial<LogisticsInput>) =>
      onChange({ ...value, logistics: { ...base, ...next } }),
    ddp = base.ddp;
  const ddpUpdate = (next: Partial<NonNullable<LogisticsInput["ddp"]>>) =>
    update({
      ddp: {
        clearingParty: "",
        qualificationEvidence: "",
        qualificationConfirmed: false as true,
        taxCap: 0,
        boundary: "",
        riskPct: 20,
        riskBase: "full_cost",
        riskReason: "",
        ...ddp,
        ...next,
      },
    });
  return (
    <Panel title="物流计价与合同费用范围">
      <p>
        <Link to="/logistics-costs">查询物流费率</Link>
        {quoteId && user.role === "admin" && (
          <>
            {" "}
            ·{" "}
            <Link to={`/logistics-costs?quote=${quoteId}`}>
              查看冻结内部计价单
            </Link>
          </>
        )}
      </p>
      <p>
        EXW 仅厂内交货；FOB/CIF 限海运或内河运输，CIF
        风险在装运地装船时转移；DAP/DDP
        到指定地点待卸货，卸货、安装和辅材由合同另行约定。退税资格不会随术语自动开启。
      </p>
      <ErrorBox message={r.error} />
      <fieldset disabled={disabled}>
        {value.incoterm === "EXW" && !current ? (
          <button
            type="button"
            onClick={() =>
              update({ scope: "EXW厂内交货，附加服务按本单合同另列" })
            }
          >
            为 EXW 添加合同附加服务
          </button>
        ) : (
          <>
            <div className="form-grid">
              {['EXW','FOB'].includes(value.incoterm)&&<><label><input type="checkbox" checked={base.reserveException??false} onChange={e=>update({reserveException:e.target.checked})}/>本单例外启用物流风险预收款（四项条款齐全才可出价）</label>{base.reserveException&&<Field label="风险预收例外原因"><input value={base.reserveExceptionReason??''} onChange={e=>update({reserveExceptionReason:e.target.value})}/></Field>}</>}
              <Field label="实际运输方式">
                <select
                  value={base.transport}
                  onChange={(e) =>
                    update({
                      transport: e.target.value as LogisticsInput["transport"],
                    })
                  }
                >
                  {Object.entries({
                    sea: "海运",
                    inland_waterway: "内河",
                    air: "空运",
                    rail: "铁路",
                    road: "公路",
                    multimodal: "多式联运",
                  }).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="柜数">
                <input
                  type="number"
                  min="1"
                  value={base.containers}
                  onChange={(e) =>
                    update({ containers: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="仓储天数">
                <input
                  type="number"
                  min="0"
                  value={base.storageDays}
                  onChange={(e) =>
                    update({ storageDays: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="本单包含与不包含的服务（必填）">
                <textarea
                  value={base.scope}
                  onChange={(e) => update({ scope: e.target.value })}
                />
              </Field>
            </div>
            <p>合同附加服务（勾选后必须有真实有效费率）：</p>
            <div className="form-grid">
              {(
                [
                  "unloading",
                  "installation",
                  "materials",
                  "storage",
                  "other",
                  "insurance",
                ] as const
              ).map((k) => (
                <label key={k}>
                  <input
                    type="checkbox"
                    checked={base.includedServices.includes(k)}
                    onChange={(e) =>
                      update({
                        includedServices: e.target.checked
                          ? [...base.includedServices, k]
                          : base.includedServices.filter((v) => v !== k),
                      })
                    }
                  />
                  {chargeLabels[k]}
                </label>
              ))}
            </div>
            <Field label="选取已核实费率（可多选；同类旧运价与新费率不可重复）">
              <select
                multiple
                size={6}
                value={base.rateIds}
                onChange={(e) =>
                  update({
                    rateIds: Array.from(
                      e.target.selectedOptions,
                      (v) => v.value,
                    ),
                  })
                }
              >
                {r.data
                  ?.filter((v) => v.country === value.country)
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {chargeLabels[v.kind]} · {v.name} V{v.version} ·{" "}
                      {v.status} · 有效至{v.validUntil}
                    </option>
                  ))}
              </select>
            </Field>
            {!r.data?.some((v) => v.country === value.country) && (
              <p>无匹配费率，请跟单员在“成本与物流计价”录入真实报价。</p>
            )}
          </>
        )}
        {value.incoterm === "DDP" &&
          (user.role === "admin" ? (
            <fieldset>
              <legend>DDP 逐单核算与特批（内部）</legend>
              {(
                [
                  ["clearingParty", "目的国法定清关主体"],
                  ["qualificationEvidence", "资格核验凭据链接/税号核验依据"],
                  ["boundary", "包干税费及服务边界（超额、卸货、安装等）"],
                  ["riskReason", "风险缓冲基数与比例的商业依据"],
                ] as const
              ).map(([k, l]) => (
                <Field key={k} label={l}>
                  <textarea
                    value={ddp?.[k] ?? ""}
                    onChange={(e) => ddpUpdate({ [k]: e.target.value })}
                  />
                </Field>
              ))}
              <label>
                <input
                  type="checkbox"
                  checked={ddp?.qualificationConfirmed === true}
                  onChange={(e) =>
                    ddpUpdate({
                      qualificationConfirmed: e.target.checked as true,
                    })
                  }
                />
                已核验目的国进口主体资格（非仅填名称）
              </label>
              <Field label={`合同税费上限 ${value.currency}`}>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={ddp?.taxCap ?? ""}
                  onChange={(e) =>
                    ddpUpdate({ taxCap: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="风险缓冲基数">
                <select
                  value={ddp?.riskBase ?? "full_cost"}
                  onChange={(e) =>
                    ddpUpdate({
                      riskBase: e.target.value as "full_cost" | "goods_cost",
                    })
                  }
                >
                  <option value="full_cost">全链路实际成本</option>
                  <option value="goods_cost">产品及包装实际成本</option>
                </select>
              </Field>
              <Field label="风险缓冲 20%–30%（一次性）">
                <input
                  type="number"
                  min="20"
                  max="30"
                  step="0.1"
                  value={ddp?.riskPct ?? 20}
                  onChange={(e) =>
                    ddpUpdate({ riskPct: Number(e.target.value) })
                  }
                />
              </Field>
              <p>保存后仍需指派人工审批；本栏不是自动批准。</p>
            </fieldset>
          ) : (
            <p>
              DDP
              的内部风险核算、清关资格及特批由管理员补齐；销售可建草稿，不能自行放行。
            </p>
          ))}
      </fieldset>
    </Panel>
  );
}
