import { useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useResource, useMutation } from "./api.ts";
import { ErrorBox, Field, Loading } from "./ui.tsx";
import { useSession } from "./context.tsx";
import {
  TC_FIELDS,
  TC_GROUPS,
  PRODUCTION_FIELDS,
  tcFieldsSchema,
  type TcTechnical,
} from "../../shared/technical.ts";
const emptyLine = () => ({
  lineKey: crypto.randomUUID(),
  kind: "door" as const,
  quantity: 1,
  widthMm: 0,
  heightMm: 0,
  fields: tcFieldsSchema.parse({}),
});
const emptyBusiness = {
  projectName: "",
  country: "",
  port: "",
  source: "",
  tradeTerm: "",
  transport: "",
  conflicts: "",
  upgradeFees: "",
  certificationPayer: "",
  certificationPeriod: "",
};
const businessLabels = {
  projectName: "项目名称",
  country: "国家/地区",
  port: "目的港",
  source: "需求来源",
  tradeTerm: "贸易术语",
  transport: "运输方式",
  conflicts: "需求矛盾声明",
  upgradeFees: "升级费用",
  certificationPayer: "认证检测费用承担",
  certificationPeriod: "预计认证周期",
};
export function TechnicalFields({
  value,
  onChange,
  original,
  onOriginal,
}: {
  value: TcTechnical;
  onChange?: (v: TcTechnical) => void;
  original?: Record<string,Record<string,string>>;
  onOriginal?: (v:Record<string,Record<string,string>>)=>void;
}) {
  return (
    <>
      {value.items.map((line, index) => (
        <section className="card" key={index}>
          <h3>产品明细 {index + 1}</h3>
          <div className="form-grid">
            <Field label="产品行标识（与报价行一致）">
              <input
                value={line.lineKey}
                readOnly={!onChange}
                onChange={(e) =>
                  onChange?.({
                    items: value.items.map((l, i) =>
                      i === index ? { ...l, lineKey: e.target.value } : l,
                    ),
                  })
                }
              />
            </Field>
            <Field label="类型">
              <select
                disabled={!onChange}
                value={line.kind}
                onChange={(e) =>
                  onChange?.({
                    items: value.items.map((l, i) =>
                      i === index
                        ? { ...l, kind: e.target.value as typeof l.kind }
                        : l,
                    ),
                  })
                }
              >
                <option value="door">门</option>
                <option value="window">窗</option>
                <option value="wall_panel">护墙板</option>
              </select>
            </Field>
            {(["quantity", "widthMm", "heightMm"] as const).map((k) => (
              <Field
                key={k}
                label={
                  { quantity: "数量", widthMm: "宽 mm", heightMm: "高 mm" }[k]
                }
              >
                <input
                  type="number"
                  min="0.001"
                  step="any"
                  required
                  value={line[k]}
                  readOnly={!onChange}
                  onChange={(e) =>
                    onChange?.({
                      items: value.items.map((l, i) =>
                        i === index ? { ...l, [k]: Number(e.target.value) } : l,
                      ),
                    })
                  }
                />
              </Field>
            ))}
          </div>
          {TC_GROUPS.map(group=><details open key={group.title}>
            <summary>{group.title}（不适用请注明原因）</summary>
            <div className="form-grid">
              {group.keys.map(key => (
                <div key={key}>
                {original&&<Field label={TC_FIELDS[key]+' · 客户原始需求'}><textarea readOnly={!onOriginal} value={original[line.lineKey]?.[key]??''} onChange={e=>onOriginal?.({...original,[line.lineKey]:{...original[line.lineKey],[key]:e.target.value}})}/></Field>}
                <Field label={TC_FIELDS[key]+(original?' · 我方确认配置':'')}>
                  <textarea
                    value={line.fields[key as keyof typeof TC_FIELDS]}
                    readOnly={!onChange}
                    onChange={(e) =>
                      onChange?.({
                        items: value.items.map((l, i) =>
                          i === index
                            ? {
                                ...l,
                                fields: { ...l.fields, [key]: e.target.value },
                              }
                            : l,
                        ),
                      })
                    }
                  />
                </Field></div>
              ))}
            </div>
          </details>)}
        </section>
      ))}
    </>
  );
}
export default function Technical() {
  const { id } = useParams();
  return id ? <Detail id={id} /> : <List />;
}
function List() {
  const r = useResource<any>("/supply/technical"),
    [project, setProject] = useState(""),
    [create, setCreate] = useState(false);
  if (r.loading) return <Loading />;
  return (
    <>
      <ErrorBox message={r.error} />
      <section className="card">
        <h2>技术确认单 TC</h2>
        <p>
          先在“报价单”建立客户项目及报价草稿。TC为技术唯一来源；保存后如需修改，创建新版本。
        </p>
        <Field label="选择客户项目">
          <select
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setCreate(false);
            }}
          >
            <option value="">请选择</option>
            {r.data?.projects.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.crm_customer_code || "待编号"} · {p.company} · {p.name}
              </option>
            ))}
          </select>
        </Field>
        <button disabled={!project} onClick={() => setCreate(true)}>
          创建TC
        </button>
        {create && <Editor key={project} projectId={project} />}
      </section>
      <section className="card">
        <h3>版本与客户确认</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>编号</th>
                <th>版本</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {r.data?.records
                .filter((t: any) => !project || t.project_id === project)
                .map((t: any) => (
                  <tr key={t.id}>
                    <td>
                      <Link to={`/technical/${t.id}`}>{t.tc_no}</Link>
                    </td>
                    <td>V{t.version}</td>
                    <td>
                      {t.superseded
                        ? "已升版 / 需变更检查"
                        : t.signed_on
                          ? "客户已签字"
                          : "待客户签字"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
function Editor({
  projectId,
  previous,
}: {
  projectId: string;
  previous?: any;
}) {
  const navigate = useNavigate(),
    m = useMutation(),
    r = useResource<any>(`/supply/technical-project/${projectId}`),
    [technical, setTechnical] = useState<TcTechnical>(
      previous?.technical ?? { items: [emptyLine()] },
    ),
    [business, setBusiness] = useState(previous?.business ?? emptyBusiness),
    [reason, setReason] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.run<any>(
          "/supply/technical",
          "POST",
          {
            projectId,
            technical,
            business,
            reason,
            ...(previous ? { previousId: previous.id } : {}),
          },
          (v) => navigate(`/technical/${v.id}`),
        );
      }}
    >
      <ErrorBox message={m.error} />
      {!previous && (
        <Field label="从报价草稿带入行标识、尺寸和数量（仍须核对全部技术内容）">
          <select
            defaultValue=""
            onChange={(e) => {
              const q = r.data?.quotes.find(
                (x: any) => x.id === e.target.value,
              );
              if (q)
                setTechnical({
                  items: q.lines.map((l: any) => ({
                    ...l,
                    kind: "door",
                    fields: tcFieldsSchema.parse(l.fields),
                  })),
                });
            }}
          >
            <option value="">手工填写 / 选择报价</option>
            {r.data?.quotes.map((q: any) => (
              <option key={q.id} value={q.id}>
                报价版本 {q.number} · {q.status}
              </option>
            ))}
          </select>
        </Field>
      )}
      <TechnicalFields value={technical} onChange={setTechnical} original={business.originalRequirements??{}} onOriginal={v=>setBusiness({...business,originalRequirements:v})}/>
      <button
        type="button"
        onClick={() =>
          setTechnical({ items: [...technical.items, emptyLine()] })
        }
      >
        添加产品明细
      </button>
      <details>
        <summary>商务信息（绝不进入工厂版）</summary>
        <div className="form-grid">
          {Object.entries(businessLabels).map(([k, label]) => (
            <Field label={label} key={k}>
              <input
                value={business[k]}
                onChange={(e) =>
                  setBusiness({ ...business, [k]: e.target.value })
                }
              />
            </Field>
          ))}
        </div>
      </details>
      <Field label="新建 / 升版原因">
        <input
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <button disabled={m.busy} className="primary">
        保存{previous ? "新版本（重新签字）" : "TC"}
      </button>
    </form>
  );
}
function Detail({ id }: { id: string }) {
  const [rev, setRev] = useState(0),
    r = useResource<any>(`/supply/technical/${id}`, rev),
    m = useMutation(),
    { user } = useSession(),
    [edit, setEdit] = useState(false),
    [file, setFile] = useState(""),
    [signer, setSigner] = useState(""),
    [date, setDate] = useState(""),
    [quote, setQuote] = useState("");
  const refresh = () => setRev((v) => v + 1);
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  const d = r.data;
  return (
    <>
      <section className="card">
        <Link to="/technical">返回TC列表</Link> ·{" "}
        <a href={`/api/supply/technical/${id}/export/pdf`}>
          下载客户确认用TC PDF
        </a>
        <h2>
          {d.tc_no} V{d.version}
        </h2>
        <p>
          {d.superseded
            ? "此版本已升版，既有MO需要变更处理"
            : d.signed_on
              ? "已记录客户签字"
              : "待客户签字确认"}
        </p>
        <ErrorBox message={m.error} />
        <button onClick={() => setEdit(!edit)} disabled={d.superseded}>
          创建修订版本
        </button>
        {edit ? (
          <Editor key={id} projectId={d.project_id} previous={d} />
        ) : (
          <TechnicalFields value={d.technical} original={d.business.originalRequirements??{}}/>
        )}
      </section>
      {!d.superseded && ["admin", "sales"].includes(user.role) && (
        <section className="card">
          <h3>记录客户确认</h3>
          <p>
            只上传客户实际签字文件。保存代表操作人已核对文件对应本TC版本，不是系统自动判断签字。
          </p>
          <Field label="上传签字PDF或图片（小于2MB）">
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              disabled={m.busy || !!d.signed_on}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const bytes = new Uint8Array(await f.arrayBuffer());
                if (bytes.length > 2e6) {
                  m.setError("附件须小于2MB");
                  return;
                }
                let data = "";
                for (const b of bytes) data += String.fromCharCode(b);
                void m.run<any>(
                  `/quoting/projects/${d.project_id}/files`,
                  "POST",
                  {
                    name: f.name,
                    mime: f.type,
                    kind: "confirmation",
                    data: btoa(data),
                  },
                  (x) => {
                    setFile(x.id);
                    refresh();
                  },
                );
              }}
            />
          </Field>
          {!d.signed_on ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void m.run(
                  `/supply/technical/${id}/confirm`,
                  "POST",
                  {
                    fileId: file,
                    signerName: signer,
                    signedOn: date,
                    verified: true,
                  },
                  refresh,
                );
              }}
            >
              <Field label="签字凭证">
                <select
                  required
                  value={file}
                  onChange={(e) => setFile(e.target.value)}
                >
                  <option value="">请选择</option>
                  {d.files
                    .filter((f: any) => f.kind === "confirmation")
                    .map((f: any) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="客户签字人">
                <input
                  required
                  value={signer}
                  onChange={(e) => setSigner(e.target.value)}
                />
              </Field>
              <Field label="实际签字日期">
                <input
                  required
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </Field>
              <label>
                <input required type="checkbox" />
                我已核对签字文件对应此TC版本
              </label>
              <button disabled={m.busy}>确认并锁定签字记录</button>
            </form>
          ) : (
            <p>
              {d.signer_name} · {String(d.signed_on).slice(0, 10)}{" "}
              <a href={`/api/quoting/files/${d.file_id}`}>查看签字凭证</a>
            </p>
          )}
          <h3>关联报价版本</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void m.run(
                `/supply/technical/${id}/bind-quote`,
                "POST",
                { quoteId: quote },
                refresh,
              );
            }}
          >
            <select
              required
              value={quote}
              onChange={(e) => setQuote(e.target.value)}
            >
              <option value="">选择报价</option>
              {d.quotes.map((q: any) => (
                <option key={q.id} value={q.id}>
                  V{q.number} {q.status} {q.tc_id ? "（已绑定）" : ""}
                </option>
              ))}
            </select>
            <button disabled={m.busy || !d.signed_on}>
              核对数量尺寸并绑定
            </button>
          </form>
          <p>
            <Link to={`/quotations/${d.project_id}`}>返回报价项目</Link> ·{" "}
            <Link to="/supply/chain">进入订单履约链生成MO</Link>
          </p>
        </section>
      )}
    </>
  );
}
export function TcManufacturingForm({
  workOrderId,
  purchases,
}: {
  workOrderId: string;
  purchases: any[];
  done?: () => void;
}) {
  const navigate = useNavigate(),
    r = useResource<any>("/supply/technical"),
    m = useMutation(),
    [tc, setTc] = useState(""),
    [po, setPo] = useState(""),
    [lines, setLines] = useState<TcTechnical["items"]>([]),
    [production, setProduction] = useState({
      requiredDate: "",
      batch: "",
      process: "",
      packingMarks: "",
      qualityPoints: "",
    });
  const selected = useResource<any>(
    `/supply/technical/${tc || "00000000-0000-0000-0000-000000000000"}`,
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.run<any>(
          `/supply/chain/${workOrderId}/manufacturing-drafts`,
          "POST",
          {
            purchaseOrderId: po,
            tcId: tc,
            lines: lines
              .filter((l) => l.quantity > 0)
              .map(({ lineKey, quantity }) => ({ lineKey, quantity })),
            production,
          },
          (v) => navigate(`/supply/manufacturing-drafts/${v.id}`),
        );
      }}
    >
      <h3>从已签字TC生成MO草稿</h3>
      <ErrorBox message={m.error} />
      <Field label="采购单">
        <select required value={po} onChange={(e) => setPo(e.target.value)}>
          <option value="">请选择</option>
          {purchases.map((p) => (
            <option value={p.id} key={p.id}>
              {p.order_number}
            </option>
          ))}
        </select>
      </Field>
      <Field label="源TC版本">
        <select
          required
          value={tc}
          onChange={(e) => {
            setTc(e.target.value);
            setLines([]);
          }}
        >
          <option value="">请选择已签字TC</option>
          {r.data?.records
            .filter((t: any) => t.signed_on && !t.superseded)
            .map((t: any) => (
              <option key={t.id} value={t.id}>
                {t.tc_no} V{t.version}
              </option>
            ))}
        </select>
      </Field>
      {selected.data && (
        <>
          <button
            type="button"
            onClick={() => setLines(selected.data.technical.items)}
          >
            载入源TC数量（可分批，0表示本批不生产）
          </button>
          {lines.map((l, i) => (
            <Field label={l.lineKey} key={l.lineKey}>
              <input
                type="number"
                min="0"
                max={
                  selected.data.technical.items.find(
                    (x: any) => x.lineKey === l.lineKey,
                  ).quantity
                }
                step="any"
                value={l.quantity}
                onChange={(e) =>
                  setLines(
                    lines.map((x, n) =>
                      n === i ? { ...x, quantity: Number(e.target.value) } : x,
                    ),
                  )
                }
              />
            </Field>
          ))}
        </>
      )}
      <ProductionFields value={production} onChange={setProduction} />
      <button className="primary" disabled={m.busy || !lines.length}>
        生成草稿并检查差异
      </button>
    </form>
  );
}
function ProductionFields({
  value,
  onChange,
}: {
  value: any;
  onChange: (v: any) => void;
}) {
  return (
    <div className="form-grid">
      {Object.entries(PRODUCTION_FIELDS).map(([k, label]) => (
        <Field label={label} key={k}>
          <input
            required
            type={k === "requiredDate" ? "date" : "text"}
            value={value[k]}
            onChange={(e) => onChange({ ...value, [k]: e.target.value })}
          />
        </Field>
      ))}
    </div>
  );
}
export function ManufacturingDraft() {
  const { id } = useParams(),
    [rev, setRev] = useState(0),
    r = useResource<any>(`/supply/manufacturing-drafts/${id}`, rev);
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  return (
    <DraftForm
      key={`${id}:${rev}`}
      d={r.data}
      refresh={() => setRev((v) => v + 1)}
    />
  );
}
function DraftForm({ d, refresh }: { d: any; refresh: () => void }) {
  const m = useMutation(),
    navigate = useNavigate(),
    [technical, setTechnical] = useState(d.technical),
    [production, setProduction] = useState(d.production);
  return (
    <section className="card">
      <h2>
        MO草稿 · {d.sourceTcNo} V{d.sourceTcVersion}
      </h2>
      <ErrorBox message={m.error} />
      {d.superseded && (
        <p role="alert">源TC已升版，下达已阻止。请完成订单变更后重新生成。</p>
      )}
      <h3>服务端逐字段差异</h3>
      {d.differences.length ? (
        <ul>
          {d.differences.map((s: string) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ) : (
        <p>
          技术内容一致（分批数量另作累计校验）。生产前仍检查定金、量尺、订单TC及权限。
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void m.run(
            `/supply/manufacturing-drafts/${d.id}`,
            "PUT",
            { revision: d.revision, technical, production },
            refresh,
          );
        }}
      >
        <TechnicalFields
          value={technical}
          onChange={d.issued ? undefined : setTechnical}
        />
        <ProductionFields value={production} onChange={setProduction} />
        <button disabled={m.busy || !!d.issued}>
          保存生产段并重新检查差异
        </button>
      </form>
      {d.issued ? (
        <Link to={`/supply/manufacturing/${d.issued}`}>查看已下达MO</Link>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void m.run<any>(
              `/supply/manufacturing-drafts/${d.id}/issue`,
              "POST",
              { revision: d.revision, partyAConfirmed: true },
              (v) => navigate(`/supply/manufacturing/${v.id}`),
            );
          }}
        >
          <label>
            <input type="checkbox" required />
            甲方确认：我已核对并批准此版本的全部技术、数量与生产要求
          </label>
          <button
            className="primary"
            disabled={
              m.busy ||
              d.superseded ||
              d.differences.length > 0 ||
              JSON.stringify(technical) !== JSON.stringify(d.technical) ||
              JSON.stringify(production) !== JSON.stringify(d.production)
            }
          >
            核验门禁并签认下达
          </button>
        </form>
      )}
    </section>
  );
}
