import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { Panel, Field, ErrorBox, Loading } from "./ui.tsx";
import {
  tariffLabels as labels,
  type TariffRecord,
  type TariffSource,
} from "../../shared/tariffs.ts";
import "./tariffs.css";
type Overview = {
  sources: TariffSource[];
  records: TariffRecord[];
  total: number;
  page: number;
  rule: {
    enabled: boolean;
    config: { time: string; timezone: "Asia/Shanghai"; usHeadings: string[] };
    version: number;
    next_run: string;
    last_success: string | null;
    last_error: string | null;
  };
  runs: {
    id: string;
    source_code: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    attempts: number;
    records: number;
    changed: number;
    error: string | null;
  }[];
};
const stamp = (v: string | null) =>
  v
    ? new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
    : "尚无记录";
export default function Tariffs() {
  const { user, revision, refresh, notify } = useSession(),
    admin = user.role === "admin";
  const m = useMutation();
  const [tab, setTab] = useState("rates"),
    [search, setSearch] = useState(""),
    [country, setCountry] = useState(""),
    [origin, setOrigin] = useState(""),
    [review, setReview] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<TariffRecord | null>(null);
  const r = useResource<Overview>(
    `/tariffs?q=${encodeURIComponent(search)}&country=${country}&origin=${origin}&review=${review}&page=${page}`,
    revision,
    60000,
    true,
  );
  const d = r.data;
  if (!["admin", "sales", "logistics"].includes(user.role))
    return <ErrorBox message="无税率查询权限" />;
  if (!d) return r.loading ? <Loading /> : <ErrorBox message={r.error} />;
  return (
    <div className="tariff-page">
      <Panel title="海关税率与来源">
        <p>
          真实来源、逐国核验。自动获取不代表已复核；不把平均税率、GCC或EAEU整体当作产品适用税率。
        </p>
        <p className="muted">
          CIF / DAP / DDP 正式报价执行
          G-37。税费计算沿用现有已核实费用规则，不自动套最低优惠税率或编造成本公式。
          <Link to="/quotations">进入报价单</Link>
        </p>
        <div className="toolbar">
          {[
            ["rates", "税率查询"],
            ["sources", "来源台账"],
            ["runs", "更新任务"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {d.rule?.last_error && (
          <ErrorBox
            message={"同步异常（保留上次成功数据）：" + d.rule.last_error}
          />
        )}
      </Panel>
      {tab === "rates" && (
        <>
          <Panel title="员工查询">
            <div className="form-grid">
              <Field label="搜索HS编码、商品或来源">
                <input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
              </Field>
              <Field label="目的国代码（如US、GB）">
                <input
                  maxLength={2}
                  value={country}
                  onChange={(e) => {
                    setCountry(e.target.value.toUpperCase());
                    setPage(1);
                  }}
                />
              </Field>
              <Field label="原产地代码（如CN）">
                <input
                  maxLength={2}
                  value={origin}
                  onChange={(e) => {
                    setOrigin(e.target.value.toUpperCase());
                    setPage(1);
                  }}
                />
              </Field>
              <Field label="复核状态">
                <select
                  value={review}
                  onChange={(e) => {
                    setReview(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">全部（含参考数据）</option>
                  {["pending", "verified", "rejected"].map((x) => (
                    <option key={x} value={x}>
                      {labels[x]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>国家 / 原产地</th>
                    <th>HS / 商品</th>
                    <th>税种 / 税率原文</th>
                    <th>日期 / 年度</th>
                    <th>来源 / 最近成功获取</th>
                    <th>复核与状态</th>
                  </tr>
                </thead>
                <tbody>
                  {d.records.map((x) => (
                    <tr key={x.id}>
                      <td>
                        {x.country} / {x.origin}
                      </td>
                      <td>
                        {x.hs_code}（{x.hs_level}位）
                        <br />
                        {x.description}
                      </td>
                      <td>
                        {labels[x.tax_kind]}
                        <br />
                        <b>{x.rate_text}</b>
                        <details>
                          <summary>适用条件</summary>
                          {x.conditions}
                        </details>
                      </td>
                      <td>
                        {x.effective_from || "生效日未提供"} →{" "}
                        {x.effective_until || "未提供截止日"}
                        <br />
                        数据年度：{x.data_year || "来源未提供"}
                        <br />
                        发布时间：
                        {x.source_published_at
                          ? stamp(x.source_published_at)
                          : "来源未提供"}
                      </td>
                      <td>
                        <a href={x.source_url} target="_blank" rel="noreferrer">
                          {x.source_name} ↗
                        </a>
                        <br />
                        首次获取：{stamp(x.fetched_at)}
                        <br />
                        最近获取：{stamp(x.last_success_at)}
                      </td>
                      <td>
                        {x.warning || labels[x.verification]}
                        <br />
                        {x.reviewer_name || "尚未复核"} /{" "}
                        {x.verified_on ? stamp(x.verified_on) : "—"}
                        <br />
                        {x.source_error && (
                          <strong>来源同步失败，旧数据保留</strong>
                        )}
                        <button onClick={() => setSelected(x)}>
                          查看 / {admin ? "复核" : "依据"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!d.records.length && (
              <p>暂无已核实数据。未提供的数据不会用0或演示金额代替。</p>
            )}
            <div className="toolbar">
              <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              <span>
                {d.total} 条，第 {page} 页
              </span>
              <button
                disabled={page * 100 >= d.total}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </div>
          </Panel>
          {selected && (
            <Panel
              title={`税率版本 V${selected.version} · ${selected.hs_code}`}
            >
              <p>{selected.conditions}</p>
              <p>
                {selected.review_note || "没有复核记录"}{" "}
                {selected.evidence_url && (
                  <a
                    href={selected.evidence_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    复核依据 ↗
                  </a>
                )}
              </p>
              <p>
                记录ID：{selected.id}；
                {selected.reference_only
                  ? "参考数据不得直接转为可报价税率。请人工录入完整国家税则记录。"
                  : "修改使用新版本，不覆盖原记录。"}
              </p>
              {admin && !selected.reference_only && (
                <ReviewForm
                  key={selected.id}
                  row={selected}
                  done={() => {
                    setSelected(null);
                    refresh();
                  }}
                />
              )}
              <button onClick={() => setSelected(null)}>关闭详情</button>
            </Panel>
          )}
          {admin && (
            <ManualForm
              key={selected?.id || "new"}
              sources={d.sources}
              prior={selected && !selected.reference_only ? selected : null}
              done={() => {
                setSelected(null);
                refresh();
              }}
            />
          )}
        </>
      )}
      {tab === "sources" && (
        <Panel title="T45 来源台账">
          <p>
            “门户可达”与“业务数据已接通”分开记录。外部网站在新窗口打开，不嵌入登录页。
          </p>
          {d.sources.map((s) => (
            <details key={s.code}>
              <summary>
                {s.name} · {labels[s.status] || s.status} ·{" "}
                {s.authority === "official"
                  ? "国家官方"
                  : s.authority === "intergovernmental"
                    ? "政府间组织"
                    : "第三方"}
              </summary>
              <p>
                {s.region} / {s.countries} · HS {s.hs_level} · {s.access_type} ·{" "}
                <a href={s.url} target="_blank" rel="noreferrer">
                  原始来源 ↗
                </a>
              </p>
              <p>{s.notes}</p>
              <p>授权 / 费用 / 限制：{s.requirements}</p>
              <p>
                最近检查：{stamp(s.checked_at)}；成功获取：
                {stamp(s.last_success_at)}；
                {s.last_error || "没有自动同步错误记录"}
              </p>
              {admin && <SourceForm source={s} />}
            </details>
          ))}
        </Panel>
      )}
      {tab === "runs" && (
        <>
          <Panel title="云端每日更新">
            <p>
              Asia/Shanghai · {d.rule?.enabled ? "已启用" : "已暂停"} · 下次：
              {stamp(d.rule?.next_run)} · 最近成功：
              {stamp(d.rule?.last_success)}
            </p>
            <p>
              任务由 Railway
              常驻服务执行，电脑关机不影响。每次最多重试3次；失败不会清空旧数据。只同步已启用的已验证适配器。
            </p>
            {admin && (
              <>
                <ScheduleForm key={d.rule.version} rule={d.rule} />
                <button
                  disabled={m.busy}
                  onClick={() =>
                    void m.run("/tariffs/run", "POST", {}, () => {
                      notify("已排队，服务器将在一分钟内执行");
                      refresh();
                    })
                  }
                >
                  立即同步
                </button>
                <ErrorBox message={m.error} />
              </>
            )}
          </Panel>
          <Panel title="最近运行记录">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>来源</th>
                    <th>开始 / 结束</th>
                    <th>实际结果</th>
                    <th>重试 / 记录 / 变更</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {d.runs.map((x) => (
                    <tr key={x.id}>
                      <td>{x.source_code}</td>
                      <td>
                        {stamp(x.started_at)}
                        <br />
                        {stamp(x.finished_at)}
                      </td>
                      <td>
                        {
                          (
                            {
                              success: "有新数据",
                              unchanged: "检查成功，无新数据",
                              failed: "失败，旧数据保留",
                              running: "执行中",
                              interrupted: "中断待重试",
                            } as Record<string, string>
                          )[x.status]
                        }
                      </td>
                      <td>
                        {x.attempts} / {x.records} / {x.changed}
                      </td>
                      <td>{x.error || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
function SourceForm({ source: s }: { source: TariffSource }) {
  const m = useMutation(),
    { refresh } = useSession(),
    [notes, setNotes] = useState(s.notes),
    [requirements, setRequirements] = useState(s.requirements),
    [enabled, setEnabled] = useState(s.enabled);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.run(
          `/tariffs/sources/${s.code}`,
          "PUT",
          { version: s.version, notes, requirements, enabled },
          refresh,
        );
      }}
    >
      <Field label="说明">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Field label="授权、费用与限制">
        <textarea
          value={requirements}
          onChange={(e) => setRequirements(e.target.value)}
        />
      </Field>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!["usitc", "wits"].includes(s.code)}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        启用已验证自动适配器
      </label>
      <ErrorBox message={m.error} />
      <button disabled={m.busy}>保存来源说明</button>
    </form>
  );
}
function ScheduleForm({ rule }: { rule: Overview["rule"] }) {
  const m = useMutation(),
    { refresh } = useSession(),
    [time, setTime] = useState(rule.config.time),
    [headings, setHeadings] = useState(rule.config.usHeadings.join(",")),
    [enabled, setEnabled] = useState(rule.enabled);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.run(
          "/tariffs/config",
          "PUT",
          {
            version: rule.version,
            enabled,
            config: {
              time,
              timezone: "Asia/Shanghai",
              usHeadings: [
                ...new Set(headings.split(/[,，\s]+/).filter(Boolean)),
              ],
            },
          },
          refresh,
        );
      }}
    >
      <div className="form-grid">
        <Field label="北京时间">
          <input
            type="time"
            required
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </Field>
        <Field label="美国章目（4位，逗号分隔，最多10个）">
          <input
            required
            value={headings}
            onChange={(e) => setHeadings(e.target.value)}
          />
        </Field>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          每日更新
        </label>
      </div>
      <ErrorBox message={m.error} />
      <button disabled={m.busy}>保存更新计划</button>
    </form>
  );
}
function ManualForm({
  sources,
  prior,
  done,
}: {
  sources: TariffSource[];
  prior: TariffRecord | null;
  done: () => void;
}) {
  const m = useMutation();
  const [f, setF] = useState({
    sourceCode: prior?.source_code || sources[0]?.code || "",
    country: prior?.country || "",
    origin: prior?.origin || "",
    hsCode: prior?.hs_code || "",
    description: prior?.description || "",
    taxKind: prior?.tax_kind || "duty",
    rateText: prior?.rate_text || "",
    conditions: prior?.conditions || "",
    effectiveFrom: prior?.effective_from || "",
    effectiveUntil: prior?.effective_until || "",
    dataYear: prior?.data_year ? String(prior.data_year) : "",
    sourceUrl: prior?.source_url || "",
  });
  return (
    <Panel
      title={
        prior ? "修订人工税率（另存新版本）" : "管理员人工录入（保存后待复核）"
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void m.run(
            "/tariffs/records",
            "POST",
            {
              ...f,
              effectiveUntil: f.effectiveUntil || null,
              dataYear: Number(f.dataYear),
              ...(prior ? { supersedesId: prior.id } : {}),
            },
            done,
          );
        }}
      >
        <div className="form-grid">
          <Field label="来源">
            <select
              value={f.sourceCode}
              onChange={(e) => setF({ ...f, sourceCode: e.target.value })}
            >
              {sources.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="税种">
            <select
              value={f.taxKind}
              onChange={(e) => setF({ ...f, taxKind: e.target.value })}
            >
              {["duty", "vat", "extra", "export_rebate"].map((k) => (
                <option key={k} value={k}>
                  {labels[k]}
                </option>
              ))}
            </select>
          </Field>
          {(
            [
              ["country", "目的国两位代码"],
              ["origin", "原产地两位代码"],
              ["hsCode", "完整国家HS编码（8—12位）"],
              ["description", "商品、材质及形态"],
              ["rateText", "税率及计价原文（如5.7%或金额/单位）"],
              ["conditions", "适用条件、附加措施及优惠资格"],
              ["effectiveFrom", "生效日期"],
              ["effectiveUntil", "截止日期（不明确留空）"],
              ["dataYear", "来源所属年度"],
              ["sourceUrl", "原始业务来源URL"],
            ] as const
          ).map(([k, label]) => (
            <Field key={k} label={label}>
              <input
                required={k !== "effectiveUntil"}
                type={
                  k.startsWith("effective")
                    ? "date"
                    : k === "dataYear"
                      ? "number"
                      : k === "sourceUrl"
                        ? "url"
                        : "text"
                }
                value={f[k]}
                onChange={(e) =>
                  setF({
                    ...f,
                    [k]: ["origin", "country"].includes(k)
                      ? e.target.value.toUpperCase()
                      : e.target.value,
                  })
                }
              />
            </Field>
          ))}
        </div>
        <p>
          不填写猜测税率；未知字段先向官方或报关人员核实。此记录保存后不能直接用于报价。
        </p>
        <ErrorBox message={m.error} />
        <button disabled={m.busy}>保存待复核记录</button>
      </form>
    </Panel>
  );
}
function ReviewForm({ row, done }: { row: TariffRecord; done: () => void }) {
  const m = useMutation(),
    [note, setNote] = useState(""),
    [url, setUrl] = useState(""),
    [checks, setChecks] = useState([false, false, false]),
    [approved, setApproved] = useState(true);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.run(
          `/tariffs/records/${row.id}/review`,
          "POST",
          {
            version: row.version,
            approved,
            note,
            evidenceUrl: url,
            confirmedNationalCode: checks[0],
            confirmedOrigin: checks[1],
            confirmedAdditionalMeasures: checks[2],
          },
          done,
        );
      }}
    >
      <Field label="官方复核依据URL">
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <Field label="复核结论（至少10字）">
        <textarea
          required
          minLength={10}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      {[
        "已核对目的国完整HS编码及商品材质/零配件分类",
        "已核对实际原产地及协定资格，不自动取最低税率",
        "已核对附加税费和适用日期；未知费用不按0处理",
      ].map((label, i) => (
        <label className="tariff-check" key={label}>
          <input
            type="checkbox"
            required
            checked={checks[i]}
            onChange={(e) =>
              setChecks(checks.map((v, j) => (i === j ? e.target.checked : v)))
            }
          />
          {label}
        </label>
      ))}
      <Field label="复核结果">
        <select
          value={String(approved)}
          onChange={(e) => setApproved(e.target.value === "true")}
        >
          <option value="true">通过</option>
          <option value="false">驳回</option>
        </select>
      </Field>
      <ErrorBox message={m.error} />
      <button disabled={m.busy}>提交复核</button>
    </form>
  );
}
