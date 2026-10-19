import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSession } from "./context.tsx";
import { api, useMutation, useResource } from "./api.ts";
import { ErrorBox, Field, Loading, Panel } from "./ui.tsx";
import {
  chargeKinds,
  chargeLabels,
  unitLabels,
  type CostRate,
} from "../../shared/logistics.ts";
import type { Product } from "../../shared/quoting.ts";
import {MaterialCosts} from './MaterialCosts.tsx';
const encoded = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str);
};
export default function Logistics() {
  const { user, revision, refresh, notify } = useSession(),
    [q, setQ] = useState(""),
    [edit, setEdit] = useState<CostRate | null | undefined>(),
    [tab, setTab] = useState("rates"),
    [params] = useSearchParams();
  const r = useResource<(CostRate & { status: string })[]>(
      "/logistics/rates",
      revision,
    ),
    canMaintain = ["admin", "logistics", "coordinator"].includes(user.role),
    canCost = ["admin", "coordinator"].includes(user.role);
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  return (
    <>
      <Panel title="成本与物流计价">
        <p>
          同一份报价数据，分别计算采购履约成本与对客销售价。当前默认 EXW / buyer
          / 不计退税；DDU 仅为 DAP 的旧称。
        </p>
        <p>
          <Link to="/daily-prices">汇率与现有航线运价（T39 / T41）</Link> ·{" "}
          <Link to="/tariffs">税率核验与来源（T40 / T45）</Link> ·{" "}
          <Link to="/quotations">生成报价</Link>
        </p>
        <div className="toolbar">
          <button onClick={() => setTab("rates")}>杂费、保险及税费公式</button>
          {canMaintain && <button onClick={()=>setTab('expiry')}>到期提醒与后台检查</button>}
          {canCost && (
            <>
              <button onClick={() => setTab("products")}>
                产品采购成本 / 配置选装
              </button>
              <button onClick={() => setTab("policy")}>底线政策</button>
              <button onClick={()=>setTab('materials')}>物料成本与选装导入</button>
            </>
          )}
        </div>
      </Panel>
      {params.get("quote") && canCost && <Sheet id={params.get("quote")!} />}
      {tab === "rates" && (
        <>
          <Panel title="真实费率版本（T42 / T43）">
            <Field label="搜索国家、提供方或费用">
              <input value={q} onChange={(e) => setQ(e.target.value)} />
            </Field>
            {canMaintain && (
              <button onClick={() => setEdit(null)}>录入真实费率</button>
            )}
            <div className="price-table">
              <table>
                <thead>
                  <tr>
                    <th>名称 / 范围</th>
                    <th>币种 / 单位 / 金额</th>
                    <th>来源 / 凭证</th>
                    <th>日期 / 版本 / 状态</th>
                    {canMaintain && <th>维护</th>}
                  </tr>
                </thead>
                <tbody>
                  {r.data
                    .filter((v) =>
                      `${v.name} ${v.country} ${v.provider} ${chargeLabels[v.kind]}`
                        .toLowerCase()
                        .includes(q.toLowerCase()),
                    )
                    .map((v) => (
                      <tr key={v.id}>
                        <td>
                          {v.name}
                          <small>
                            {chargeLabels[v.kind]} · {v.country} ·{" "}
                            {v.originPort} → {v.destination}
                          </small>
                          <small>{v.scope}</small>
                        </td>
                        <td>
                          {v.currency} / {unitLabels[v.unit]}
                          <small>
                            {canMaintain
                              ? `${v.rate}（最低${v.minimum}）`
                              : "采购费用按权限隐藏"}
                          </small>
                        </td>
                        <td>
                          {v.provider}
                          {canMaintain && (
                            <small>
                              <a
                                target="_blank"
                                rel="noreferrer"
                                href={
                                  v.evidence.startsWith("file:")
                                    ? `/api/logistics/evidence/${v.evidence.slice(5)}`
                                    : v.evidence
                                }
                              >
                                原始凭据
                              </a>
                            </small>
                          )}
                        </td>
                        <td>
                          来源发布：{v.sourceDate}
                          <small>
                            {v.validFrom} 至 {v.validUntil}
                          </small>
                          <small>
                            V{v.version} · {v.status} · 人工维护
                          </small>
                        </td>
                        {canMaintain && (
                          <td>
                            <button onClick={() => setEdit(v)}>升版</button>
                            <History id={v.id} />
                          </td>
                        )}
                      </tr>
                    ))}
                </tbody>
              </table>
              {!r.data.length && (
                <p>
                  暂无已核实费率。等待货代、保险公司或工厂真实资料，未用演示金额代替。
                </p>
              )}
            </div>
          </Panel>
          {canMaintain && edit !== undefined && (
            <RateForm
              key={edit?.id ?? "new"}
              rate={edit}
              rates={r.data}
              done={() => {
                setEdit(undefined);
                refresh();
                notify("费率新版本已保存，历史报价保持不变");
              }}
              cancel={() => setEdit(undefined)}
            />
          )}
          {canMaintain && <ImportRates />}
        </>
      )}
      {tab === "products" && canCost && <ProductCosts />}
      {tab === "policy" && canCost && <Policy />}
      {tab === 'expiry' && canMaintain && <Expiry />}
      {tab === 'materials' && canCost && <MaterialCosts />}
    </>
  );
}
function Expiry(){
  const {user,revision,refresh,notify}=useSession(),m=useMutation();
  type State={rule:{enabled:boolean;version:number;config:{time:string;timezone:'Asia/Shanghai';warningDays:number};next_run:string;last_success:string|null;last_error:string|null;last_heartbeat:string|null};alerts:{entity:string;entity_id:string;version:number;state:string;name:string;valid_until:string|null;checked_at:string}[];runs:{id:string;status:string;started_at:string;alert_count:number|null;error:string|null}[]};
  const r=useResource<State>('/logistics/expiry',revision);
  if(r.loading)return <Loading/>;
  if(!r.data)return <ErrorBox message={r.error}/>;
  const {rule,alerts,runs}=r.data;
  return <Panel title="成本与费率到期提醒（云端运行）"><p>只生成内部提醒，不延长有效期、不修改原价格、不发送客户消息。关闭电脑后仍执行。</p>
    <p>最近成功：{rule.last_success?new Date(rule.last_success).toLocaleString():'尚未成功运行'}；下次：{new Date(rule.next_run).toLocaleString()}（北京时间）；状态：{rule.enabled?'已启用':'已停用'}</p>
    <ErrorBox message={rule.last_error||m.error}/>
    {user.role==='admin'&&<form key={rule.version} onSubmit={ev=>{ev.preventDefault();const f=new FormData(ev.currentTarget);void m.run('/logistics/expiry','PUT',{version:rule.version,enabled:f.get('enabled')==='on',config:{time:String(f.get('time')),warningDays:Number(f.get('days')),timezone:'Asia/Shanghai'}},()=>{refresh();notify('后台检查设置已保存');});}}>
      <div className="form-grid"><Field label="每日检查时间（北京时间）"><input type="time" name="time" required defaultValue={rule.config.time}/></Field><Field label="提前提醒天数"><input type="number" name="days" min={0} max={90} required defaultValue={rule.config.warningDays}/></Field><label><input type="checkbox" name="enabled" defaultChecked={rule.enabled}/>启用服务器到期检查</label></div>
      <button disabled={m.busy}>保存检查设置</button> <button type="button" disabled={m.busy} onClick={()=>void m.run('/logistics/expiry/check','POST',{},()=>{refresh();notify('已排队，服务器将在一分钟内检查');})}>立即检查</button>
    </form>}
    <div className="price-table"><table><thead><tr><th>记录</th><th>版本</th><th>有效至</th><th>状态</th><th>最近检查</th></tr></thead><tbody>{alerts.map(a=><tr key={`${a.entity}:${a.entity_id}:${a.version}:${a.state}`}><td>{a.name}（{a.entity==='product'?'产品':a.entity==='freight'?'航线':'杂费/保险'}）</td><td>V{a.version}</td><td>{a.valid_until??'缺少有效期'}</td><td>{{due:'即将到期',expired:'已过期',missing:'待补有效期'}[a.state]}</td><td>{new Date(a.checked_at).toLocaleString()}</td></tr>)}</tbody></table></div>
    {!alerts.length&&<p>{rule.last_success?'最近一次检查无到期提醒；不代表空白产品或费用已配置。':'尚无成功检查记录，不能判断无到期项。'}</p>}
    <h3>实际运行记录</h3>{runs.map(run=><p key={run.id}>{new Date(run.started_at).toLocaleString()} · {run.status==='success'?`完成，${run.alert_count}条提醒`:run.error}</p>)}
  </Panel>;
}
function RateForm({
  rate,
  rates,
  done,
  cancel,
}: {
  rate: CostRate | null;
  rates: CostRate[];
  done: () => void;
  cancel: () => void;
}) {
  const m = useMutation(),
    [kind, setKind] = useState(rate?.kind ?? "domestic"),
    [evidence, setEvidence] = useState(rate?.evidence ?? ""),
    [error, setError] = useState("");
  const taxes = useResource<{
    records: {
      id: string;
      hs_code: string;
      country: string;
      origin: string;
      rate_text: string;
      tax_kind: string;
      verification: string;
    }[];
  }>("/tariffs?review=verified");
  return (
    <Panel title={rate ? `${rate.name}：建立新版本（旧版保留）` : "新增费率"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget),
            s = (k: string) => String(f.get(k) ?? ""),
            n = (k: string) => Number(s(k));
          void m.run(
            rate ? `/logistics/rates/${rate.id}/version` : "/logistics/rates",
            "POST",
            {
              reason: s("reason"),
              data: {
                name: s("name"),
                kind,
                country: s("country"),
                originPort: s("originPort"),
                destination: s("destination"),
                transport: s("transport"),
                currency: s("currency"),
                unit: s("unit"),
                rate: n("rate"),
                minimum: n("minimum"),
                validFrom: s("validFrom"),
                validUntil: s("validUntil"),
                sourceDate: s("sourceDate"),
                provider: s("provider"),
                evidence,
                scope: s("scope"),
                tariffId: s("tariffId") || null,
                taxBase: f.getAll("taxBase"),
                priorTaxes: f.getAll("priorTaxes"),
              },
            },
            done,
          );
        }}
      >
        <div className="form-grid">
          {(
            [
              ["name", "费率名称"],
              ["country", "适用国家（与报价国家完全一致）"],
              ["originPort", "起运港（不限制留空）"],
              ["destination", "适用城市/目的港（不限制留空）"],
              ["currency", "币种，如 CNY / USD"],
              ["provider", "货代/保险公司/官方来源"],
            ] as const
          ).map(([k, l]) => (
            <Field label={l} key={k}>
              <input
                name={k}
                defaultValue={rate?.[k] ?? ""}
                required={!["originPort", "destination"].includes(k)}
              />
            </Field>
          ))}
          <Field label="费用类型">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as CostRate["kind"])}
            >
              {chargeKinds.map((k) => (
                <option key={k} value={k}>
                  {chargeLabels[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="计价单位">
            <select name="unit" defaultValue={rate?.unit ?? "fixed"}>
              {Object.entries(unitLabels).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="适用运输">
            <select name="transport" defaultValue={rate?.transport ?? "any"}>
              {Object.entries({
                any: "不限",
                sea: "海运",
                inland_waterway: "内河运输",
                air: "航空",
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
          {(["rate", "minimum"] as const).map((k) => (
            <Field
              key={k}
              label={
                k === "rate" ? "真实费率（%填5代表5%）" : "最低收费（同币种）"
              }
            >
              <input
                required
                name={k}
                type="number"
                min="0"
                step="any"
                defaultValue={rate?.[k] ?? (k === "minimum" ? 0 : "")}
              />
            </Field>
          ))}
          {(["sourceDate", "validFrom", "validUntil"] as const).map((k) => (
            <Field
              key={k}
              label={
                {
                  sourceDate: "来源发布日期",
                  validFrom: "生效日",
                  validUntil: "失效日",
                }[k]
              }
            >
              <input
                required
                name={k}
                type="date"
                defaultValue={rate?.[k] ?? ""}
              />
            </Field>
          ))}
          <Field label="适用货物、承保范围、包含/不含项目">
            <textarea
              required
              minLength={5}
              name="scope"
              defaultValue={rate?.scope ?? ""}
            />
          </Field>
          <Field label="本次录入/升版原因">
            <textarea required minLength={5} name="reason" />
          </Field>
          <Field label="原始报价或官方凭据 HTTPS 链接">
            <input
              required
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
            />
          </Field>
          <Field label="或上传凭证（PDF/PNG/JPEG，≤2MB）">
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  if (f.size > 2 * 1024 * 1024) throw new Error("文件超过2MB");
                  const r = await api<{ evidence: string }>(
                    "/logistics/evidence",
                    "POST",
                    { name: f.name, data: await encoded(f) },
                  );
                  setEvidence(r.evidence);
                  setError("");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            />
          </Field>
        </div>
        {["duty", "vat", "extra"].includes(kind) && (
          <fieldset>
            <legend>税费计算依据：必须来自同税种已核验官方记录</legend>
            <Field label="T40已核验税目（最多列前100项；可在海关税率页查ID）">
              <select
                name="tariffId"
                required
                defaultValue={rate?.tariffId ?? ""}
              >
                <option value="">请选择</option>
                {taxes.data?.records
                  .filter((r) => r.tax_kind === kind)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.country}/{r.origin} · {r.hs_code} · {r.rate_text}
                    </option>
                  ))}
              </select>
            </Field>
            <p>
              仅支持已核验的从价百分比税。申报货值取对客产品及包装金额；运保费按货值比例分摊至各HS明细。与当地官方计税口径不符时不得套用本公式。
            </p>
            <div className="form-grid">
              {[
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
              ].map((k) => (
                <label key={k}>
                  <input
                    type="checkbox"
                    name="taxBase"
                    value={k}
                    defaultChecked={rate?.taxBase.includes(k as never)}
                  />
                  {k === "goods"
                    ? "申报货值（对客产品+包装）"
                    : chargeLabels[k]}
                </label>
              ))}
            </div>
            <Field label="需计入税基的前序税（可多选）">
              <select
                multiple
                name="priorTaxes"
                defaultValue={rate?.priorTaxes ?? []}
              >
                {rates
                  .filter((r) => ["duty", "vat", "extra"].includes(r.kind))
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} V{r.version}
                    </option>
                  ))}
              </select>
            </Field>
          </fieldset>
        )}
        <ErrorBox message={m.error || error} />
        <button className="primary" disabled={m.busy}>
          保存新版本
        </button>{" "}
        <button type="button" onClick={cancel}>
          取消
        </button>
      </form>
    </Panel>
  );
}
function History({ id }: { id: string }) {
  const [rows, setRows] = useState<
      { version: number; reason: string; created_at: string }[] | null
    >(null),
    [error, setError] = useState("");
  return (
    <>
      <button
        onClick={() =>
          void api<typeof rows>(`/logistics/rates/${id}/history`)
            .then(setRows)
            .catch((e) => setError(e.message))
        }
      >
        变更记录
      </button>
      {rows?.map((r) => (
        <small key={r.version}>
          V{r.version} · {r.reason} · {new Date(r.created_at).toLocaleString()}
        </small>
      ))}
      <ErrorBox message={error} />
    </>
  );
}
function ImportRates() {
  const m = useMutation(),
    { refresh, notify } = useSession(),
    [preview, setPreview] = useState<{
      id: string;
      rows: { row: number; data: CostRate | null; errors: string[]; duplicate?: boolean }[];
    } | null>(null);
  return (
    <Panel title="批量导入：先预览，再确认">
      <a href="/api/logistics/import-template" download>
        下载费率CSV模板
      </a>
      <p>
        费用类型使用 domestic / export / international / insurance / destination
        / customs / delivery / unloading / installation / materials / storage /
        other；单位 fixed / container / cbm / kg / piece / day / percent /
        permille。税费公式请逐项核验维护，不从批量表盲目发布。
      </p>
      <input
        aria-label="导入物流费率"
        type="file"
        accept=".csv,.xlsx"
        disabled={m.busy}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          if (f.size > 2 * 1024 * 1024) {
            m.setError("文件超过2MB");
            return;
          }
          await m.run(
            "/logistics/import-preview",
            "POST",
            { name: f.name, data: await encoded(f) },
            setPreview,
          );
        }}
      />
      <ErrorBox message={m.error} />
      {preview && (
        <>
          <div className="price-table">
            <table>
              <thead>
                <tr>
                  <th>行号</th>
                  <th>内容</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.row}>
                    <td>{r.row}</td>
                    <td>
                      {r.data?.name} {r.data?.rate} {r.data?.currency}
                    </td>
                    <td>
                      {r.errors.join("；") || (r.duplicate ? "重复记录，确认时复用已有版本" : "格式通过，待人工核对原始报价")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            disabled={
              m.busy ||
              !preview.rows.length ||
              preview.rows.some((r) => r.errors.length)
            }
            onClick={() =>
              void m.run(
                `/logistics/imports/${preview.id}/commit`,
                "POST",
                {},
                () => {
                  setPreview(null);
                  refresh();
                  notify("导入已完成，相同请求不会重复建费率");
                },
              )
            }
          >
            已核对真实报价，确认导入
          </button>
        </>
      )}
    </Panel>
  );
}
function Policy() {
  const { user, revision, refresh } = useSession(),
    r = useResource<{
      data: { floorMultiplier: number; landedMultiplier: number; risk_reserve_pct:number;reservePrepaid:boolean;reserveActualSettlement:boolean;reserveUnusedRefund:boolean;reserveRefundDeadline:string };
      version: number;
    }>("/logistics/policy", revision),
    m = useMutation();
  if (!r.data) return <ErrorBox message={r.error} />;
  return (
    <Panel title="产品底线与全链路底线">
      <form
        key={r.data.version}
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void m.run(
            "/logistics/policy",
            "PUT",
            {
              version: r.data!.version,
              data: {
                ...r.data!.data,
                risk_reserve_pct:Number(f.get('reserve'))/100,
                reservePrepaid:f.get('prepaid')==='on',reserveActualSettlement:f.get('actual')==='on',reserveUnusedRefund:f.get('refund')==='on',reserveRefundDeadline:String(f.get('deadline')??''),
                floorMultiplier: Number(f.get("floor")),
                landedMultiplier: Number(f.get("landed")),
              },
              reason: f.get("reason"),
            },
            refresh,
          );
        }}
      >
        <Field label="产品采购成本底线系数">
          <input
            name="floor"
            type="number"
            min={1}
            max={10}
            step="0.01"
            defaultValue={r.data.data.floorMultiplier}
            disabled={user.role !== "admin"}
          />
        </Field>
        <Field label="全链路成本底线系数">
          <input
            name="landed"
            type="number"
            min={1}
            max={10}
            step="0.01"
            defaultValue={r.data.data.landedMultiplier}
            disabled={user.role !== "admin"}
          />
        </Field>
        <fieldset disabled={user.role!=='admin'}><legend>物流风险预收款（独立于内部利润缓冲）</legend><Field label="风险预收比例 %"><input name="reserve" type="number" min="0" max="100" step="0.1" defaultValue={r.data.data.risk_reserve_pct*100}/></Field><label><input type="checkbox" name="prepaid" defaultChecked={r.data.data.reservePrepaid}/>明确为预收款</label><label><input type="checkbox" name="actual" defaultChecked={r.data.data.reserveActualSettlement}/>据实结算</label><label><input type="checkbox" name="refund" defaultChecked={r.data.data.reserveUnusedRefund}/>未发生全额退还</label><Field label="退还时限（起算事件、天数；未确认请留空）"><input name="deadline" defaultValue={r.data.data.reserveRefundDeadline}/></Field><p>CIF/DAP/DDP默认启用；EXW/FOB默认关闭。四项条款缺少任一项即阻止相关正式报价。</p></fieldset>
        {user.role === "admin" && (
          <>
            <Field label="调整原因（必填，旧值和新值将审计）">
              <input name="reason" required minLength={5} />
            </Field>
            <button disabled={m.busy}>保存并立即生效</button>
          </>
        )}
        <p>
          低于实际成本不可审批放行。低于底线但不低于成本，走人工审批。历史已签发报价不变。
        </p>
        <ErrorBox message={m.error} />
      </form>
    </Panel>
  );
}
function ProductCosts() {
  const { revision } = useSession(),
    r = useResource<{ id: string; version: number; data: Product }[]>(
      "/logistics/products",
      revision,
    ),
    [selected, setSelected] = useState("");
  return (
    <Panel title="复用现有产品主档：采购成本、销售基价与选装">
      <p>
        金额单位：CNY /
        产品主档计价单位。成本与销售价格分开录入，尺寸和选项仍由原产品规则计算。
      </p>
      <ErrorBox message={r.error} />
      <select
        aria-label="选择维护成本的产品"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="">请选择产品</option>
        {r.data?.map((r) => (
          <option key={r.id} value={r.id}>
            {r.data.sku} · {r.data.nameZh} V{r.version}
          </option>
        ))}
      </select>
      {r.data
        ?.filter((r) => r.id === selected)
        .map((r) => (
          <ProductCostForm key={`${r.id}:${r.version}`} row={r} />
        ))}
    </Panel>
  );
}
function ProductCostForm({
  row,
}: {
  row: { id: string; version: number; data: Product };
}) {
  const { refresh, notify } = useSession(),
    m = useMutation();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void m.run(
          `/logistics/products/${row.id}/cost`,
          "POST",
          {
            version: row.version,
            cost: Number(f.get("cost")),
            guide: Number(f.get("guide")),
            sourceDate:f.get('sourceDate'),
            validFrom: f.get("from"),
            validUntil: f.get("until"),
            provider: f.get("provider"),
            evidence: f.get("evidence"),
            reason: f.get("reason"),
            options: row.data.options.map((o) => ({
              id: o.id,
              cost: Number(f.get(`cost:${o.id}`)),
              sale: Number(f.get(`sale:${o.id}`)),
            })),
          },
          () => {
            refresh();
            notify("成本已升版；已签发报价不变");
          },
        );
      }}
    >
      <div className="form-grid">
        <Field label="P-COST 实际采购成本">
          <input
            name="cost"
            required
            type="number"
            min="0"
            step="any"
            defaultValue={row.data.prices.internal ?? ""}
          />
        </Field>
        <Field label="P-GUIDE 对客基价">
          <input
            name="guide"
            required
            type="number"
            min="0"
            step="any"
            defaultValue={row.data.prices.guide ?? ""}
          />
        </Field>
        <Field label="工厂价格来源日期">
          <input required name="sourceDate" type="date" defaultValue={row.data.provenance?.sourceDate??''}/>
        </Field>
        <Field label="生效日">
          <input required name="from" type="date" />
        </Field>
        <Field label="失效日">
          <input
            required
            name="until"
            type="date"
            defaultValue={row.data.priceValidUntil ?? ""}
          />
        </Field>
        <Field label="工厂/供应商">
          <input required name="provider" />
        </Field>
        <Field label="原始价目表凭证链接">
          <input required minLength={5} name="evidence" />
        </Field>
        <Field label="升版原因">
          <input required minLength={5} name="reason" />
        </Field>
      </div>
      {row.data.options.map((o) => (
        <fieldset key={o.id}>
          <legend>
            {o.group} · {o.nameZh} · {o.basis}
          </legend>
          <Field label="选装采购成本 CNY">
            <input
              required
              name={`cost:${o.id}`}
              type="number"
              min="0"
              step="any"
              defaultValue={o.cost ?? ""}
              readOnly={!!o.material}
            />
          </Field>
          <Field label="选装销售升级费 CNY">
            <input
              required
              name={`sale:${o.id}`}
              type="number"
              min="0"
              step="any"
              defaultValue={o.sale ?? ""}
            />
          </Field>
        </fieldset>
      ))}
      <ErrorBox message={m.error} />
      <button disabled={m.busy}>核实来源并建立新成本版本</button>
    </form>
  );
}
function Sheet({ id }: { id: string }) {
  const r = useResource<{
    snapshot: import("../../shared/logistics.ts").LogisticsSnapshot;
  }>(`/logistics/sheets/${id}`);
  if (!r.data) return <ErrorBox message={r.error} />;
  const s = r.data.snapshot;
  return (
    <Panel title="冻结物流计价单 T44（内部）">
      <p>
        {s.term} · {s.ruleVersion} · {s.scope}
      </p>
      <p>
        产品及包装实际成本 CNY {s.goodsCostCny}；全链路成本 {s.costCny}；底线{" "}
        {s.floorCny}；销售 {s.saleCny ?? "未核价"}；利润{" "}
        {s.profitCny ?? "未核价"}
      </p>
      <div className="price-table">
        <table>
          <thead>
            <tr>
              <th>项目</th>
              <th>成本 CNY</th>
              <th>计算依据</th>
            </tr>
          </thead>
          <tbody>
            {s.components.map((r) => (
              <tr key={r.key}>
                <td>{chargeLabels[r.kind]}</td>
                <td>{r.costCny}</td>
                <td>{r.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>仅内部授权账号可读取，不作为工厂版或客户版外发。</p>
      <a href={`/api/logistics/sheets/${id}/export`} download>导出内部物流计价 Excel</a>
    </Panel>
  );
}
