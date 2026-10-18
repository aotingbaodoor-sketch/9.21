import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useResource, useMutation } from "./api.ts";
import { Field, ErrorBox, Loading } from "./ui.tsx";
import { CAD_LIMITATIONS, cadSvg } from "../../shared/cad.ts";
import { TC_FIELDS } from "../../shared/technical.ts";
import "./cad.css";
const blankDetails = () => ({
  openingWidthMm: null,
  openingHeightMm: null,
  leafWidthMm: null,
  leafHeightMm: null,
  depthMm: null,
  viewDirection: "",
  location: "",
  evidence: "",
});
async function encoded(f: File) {
  let out = "";
  const a = new Uint8Array(await f.arrayBuffer());
  for (let n = 0; n < a.length; n += 32768)
    out += String.fromCharCode(...a.subarray(n, n + 32768));
  return btoa(out);
}
function Viewer({ analysis }: { analysis: any }) {
  const [hidden, setHidden] = useState<string[]>([]),
    [zoom, setZoom] = useState(1),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<any>(null);
  if (!analysis) return null;
  return (
    <section className="cad-viewer">
      <label>
        缩放{" "}
        <input
          aria-label="图纸缩放"
          type="range"
          min="0.3"
          max="3"
          step="0.1"
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
        />
      </label>
      {!!analysis.pages?.length && (
        <label>
          原图页码{" "}
          <select
            value={page}
            onChange={(e) => setPage(Number(e.target.value))}
          >
            {analysis.pages.map((_: any, i: number) => (
              <option key={i} value={i}>
                第{i + 1}页
              </option>
            ))}
          </select>
        </label>
      )}
      {analysis.layers?.map((l: any) => (
        <label key={l.name}>
          <input
            type="checkbox"
            checked={!hidden.includes(l.name)}
            onChange={(e) =>
              setHidden(
                e.target.checked
                  ? hidden.filter((n) => n !== l.name)
                  : [...hidden, l.name],
              )
            }
          />
          {l.name}
          {l.hidden ? "（原隐藏层，仍纳入分析）" : ""}
        </label>
      ))}
      <div className="cad-canvas">
        <img
          style={{ width: `${zoom * 100}%`, maxWidth: "none" }}
          alt="图纸预览（不可量图作为生产尺寸）"
          src={
            analysis.pages?.[page]
              ? "data:image/png;base64," + analysis.pages[page].png
              : "data:image/svg+xml;charset=utf-8," +
                encodeURIComponent(cadSvg(analysis.primitives || [], hidden))
          }
        />
        {selected?.region && (
          <p>
            来源：第{selected.page}页，区域X/Y/宽/高：
            {selected.region
              .map((x: number) => (x * 100).toFixed(1) + "%")
              .join(" / ")}
          </p>
        )}
      </div>
      <p>
        单位编码：
        {(
          {
            0: "未定义，必须确认",
            1: "英寸",
            4: "毫米",
            5: "厘米",
            6: "米",
          } as any
        )[analysis.units] ?? analysis.units}
        ；所有识别结果待人工确认。
      </p>
      <details>
        <summary>
          实体、文字、标注及定位依据（
          {analysis.entities?.length || analysis.evidence?.length || 0}项）
        </summary>
        <div className="cad-table">
          <table>
            <thead>
              <tr>
                <th>依据</th>
                <th>图层/页码</th>
                <th>识别内容</th>
                <th>几何标注/置信度</th>
              </tr>
            </thead>
            <tbody>
              {(analysis.entities || analysis.evidence || []).map(
                (r: any, n: number) => (
                  <tr key={n}>
                    <td>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(r);
                          if (r.page) setPage(r.page - 1);
                        }}
                      >
                        {r.id || `文字${n + 1}`}
                      </button>
                    </td>
                    <td>{r.layer || `第${r.page}页`}</td>
                    <td>
                      {r.type} {r.text || r.block || ""}
                      {r.attributes && JSON.stringify(r.attributes)}
                    </td>
                    <td>{r.measurement ?? r.confidence ?? "—"}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
        {selected && (
          <p>
            选中依据：{selected.id || selected.text}；范围：
            {JSON.stringify(
              selected.bounds || selected.region || "原图定位待人工核对",
            )}
          </p>
        )}
      </details>
      {analysis.warnings?.map((w: string, i: number) => (
        <p key={i} className="muted">
          {w}
        </p>
      ))}
      {analysis.repeatedTexts?.length > 0 && (
        <p role="alert">
          重复文字/编号候选：{analysis.repeatedTexts.join("、")}
          （须人工判断，不自动合并构件）
        </p>
      )}
    </section>
  );
}
export default function Cad() {
  const { projectId } = useParams(),
    [rev, setRev] = useState(0),
    projects = useResource<any>("/supply/technical"),
    navigate = useNavigate();
  if (!projectId)
    return (
      <section className="card">
        <h2>CAD图纸分析与深化</h2>
        <p>仅对需要深化的项目启用；原图仅内部保存，不上传外部AI。</p>
        <ErrorBox message={projects.error} />
        {projects.loading ? (
          <Loading />
        ) : (
          <>
            <label>
              选择深化项目
              <select
                aria-label="选择深化项目"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) navigate("/cad/" + e.target.value);
                }}
              >
                <option value="">请选择</option>
                {projects.data?.projects?.map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.company} · {p.name}
                  </option>
                ))}
              </select>
            </label>
            <Link to="/technical">没有项目？选择在用客户并创建报价项目</Link>
          </>
        )}
      </section>
    );
  return (
    <Workspace
      key={projectId}
      projectId={projectId}
      rev={rev}
      refresh={() => setRev((n) => n + 1)}
    />
  );
}
function Workspace({
  projectId,
  rev,
  refresh,
}: {
  projectId: string;
  rev: number;
  refresh: () => void;
}) {
  const r = useResource<any>("/supply/cad/projects/" + projectId, rev),
    m = useMutation(),
    [file, setFile] = useState<File | null>(null),
    [enabled, setEnabled] = useState(false),
    [sourceId, setSource] = useState(""),
    [versionId, setVersion] = useState("");
  return (
    <>
      <div className="quote-toolbar">
        <Link to="/cad">← 深化项目</Link>
        <Link to={"/quotations/" + projectId}>报价项目</Link>
        <Link to="/technical">技术确认单TC</Link>
      </div>
      <section className="card">
        <h2>CAD图纸分析与深化 · {r.data?.project.name}</h2>
        <p>
          ① 上传分析 → ② 确认单位/参数 → ③ 生成深化草稿 → ④ 技术审核 → ⑤
          关联TC/MO（生产批准另行完成）
        </p>
        <p>{CAD_LIMITATIONS}</p>
        <details>
          <summary>实际格式能力与限制</summary>
          <p>
            DXF：真实读取模型空间实体、图层、文字、标注、图块；生成可编辑线条/文字/尺寸。复杂曲线、外参及不支持实体会提示，不保证简图完整还原。DWG：仅存原件，请原CAD软件另存DXF。PDF/PNG/JPEG：按图像处理，本地OCR提供页码/区域与置信度，不能从像素推算尺寸。导出：DXF、PDF、SVG、参数报告；DWG导出未接入。
          </p>
        </details>
        <ErrorBox message={r.error || m.error} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (file)
              void encoded(file).then((data) =>
                m.run<any>(
                  "/supply/cad/projects/" + projectId + "/sources",
                  "POST",
                  { name: file.name, data, enableDrafting: enabled },
                  (v) => {
                    setSource(v.id);
                    refresh();
                  },
                ),
              );
          }}
        >
          <Field label="上传内部原图（4MB内，PDF最多5页）">
            <input
              type="file"
              accept=".dxf,.dwg,.pdf,.png,.jpg,.jpeg"
              required
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </Field>
          <label>
            <input
              type="checkbox"
              required
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            本项目需要深化；启用后未完成生产图批准不得下达MO，当前草稿不能投产
          </label>
          <button disabled={m.busy || !file || !enabled}>
            保存原图并启用深化
          </button>
        </form>
        {r.loading ? (
          <Loading />
        ) : (
          <div className="form-grid">
            <Field label="选择原图 / CAD软件修改后的文件请重新上传">
              <select
                value={sourceId}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">请选择</option>
                {r.data?.sources.map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.status || "未分析"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="深化历史版本">
              <select
                value={versionId}
                onChange={(e) => setVersion(e.target.value)}
              >
                <option value="">请选择</option>
                {r.data?.versions.map((v: any) => (
                  <option key={v.id} value={v.id}>
                    V{v.version} · {v.decision || "待审核"} · {v.reason}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
      </section>
      {sourceId && r.data && (
        <Source
          key={sourceId + ":" + rev}
          id={sourceId}
          workspace={r.data}
          refresh={refresh}
          onGenerated={setVersion}
        />
      )}
      {versionId && (
        <Version
          key={versionId + ":" + rev}
          id={versionId}
          canReview={r.data?.canReview}
          refresh={refresh}
        />
      )}
    </>
  );
}
function Source({
  id,
  workspace,
  refresh,
  onGenerated,
}: {
  id: string;
  workspace: any;
  refresh: () => void;
  onGenerated: (id: string) => void;
}) {
  const r = useResource<any>("/supply/cad/sources/" + id),
    m = useMutation(),
    [tcId, setTc] = useState("");
  return (
    <section className="card">
      <h3>原图分析 · {r.data?.name}</h3>
      <ErrorBox message={r.error || m.error || r.data?.analysis?.error} />
      <a href={"/api/supply/cad/sources/" + id + "/download"}>下载内部原件</a>
      <button
        disabled={m.busy}
        onClick={() =>
          void m.run(
            "/supply/cad/sources/" + id + "/analyze",
            "POST",
            {},
            refresh,
          )
        }
      >
        {m.busy ? "服务器分析中…原件已保存" : "分析图纸 / 失败重试"}
      </button>
      <p>未修改的文件复用已成功结果。服务器处理不依赖浏览器常开。</p>
      <Viewer analysis={r.data?.analysis?.result} />
      <Field label="关联真实TC版本">
        <select value={tcId} onChange={(e) => setTc(e.target.value)}>
          <option value="">请选择</option>
          {workspace.tcs.map((t: any) => (
            <option key={t.id} value={t.id}>
              {t.tc_no} V{t.version}
            </option>
          ))}
        </select>
      </Field>
      {!workspace.tcs.length && (
        <p>
          本项目尚无TC，请先到<Link to="/technical">技术确认单</Link>
          填写实际尺寸及配置；不生成虚假TC。
        </p>
      )}
      {tcId && (
        <Parameters
          key={tcId}
          tc={workspace.tcs.find((t: any) => t.id === tcId)}
          sourceId={id}
          projectId={workspace.project.id}
          baseVersion={workspace.versions[0]?.version || 0}
          done={(v) => {
            onGenerated(v.id);
            refresh();
          }}
        />
      )}
    </section>
  );
}
function Parameters({
  tc,
  sourceId,
  projectId,
  baseVersion,
  done,
}: {
  tc: any;
  sourceId: string;
  projectId: string;
  baseVersion: number;
  done: (v: any) => void;
}) {
  const m = useMutation(),
    [technical, setTechnical] = useState<any>(structuredClone(tc.technical)),
    [details, setDetails] = useState<any>(
      Object.fromEntries(
        tc.technical.items.map((i: any) => [i.lineKey, blankDetails()]),
      ),
    ),
    [units, setUnits] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [reason, setReason] = useState(""),
    [basis, setBasis] = useState(""),
    [notes, setNotes] = useState("");
  const line = (index: number, key: string, value: any) =>
    setTechnical((old: any) => ({
      ...old,
      items: old.items.map((i: any, n: number) =>
        n === index ? { ...i, [key]: value } : i,
      ),
    }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.run(
          "/supply/cad/projects/" + projectId + "/versions",
          "POST",
          {
            sourceId,
            tcId: tc.id,
            baseVersion,
            reason,
            parameters: {
              units,
              scaleConfirmed: confirmed,
              technical,
              details,
              engineeringBasis: basis,
              notes,
            },
          },
          done,
        );
      }}
    >
      <h3>确认参数（由TC预填，未知项留空）</h3>
      <ErrorBox message={m.error} />
      <p>
        修改产生TC差异时只生成建议，不覆盖TC；需要升版后重新客户确认。此处数量为图纸对应TC总量，不是MO分批数量。
      </p>
      <Field label="确认输出单位">
        <select
          required
          value={units}
          onChange={(e) => setUnits(e.target.value)}
        >
          <option value="">必须确认</option>
          <option value="mm">毫米 mm（已将原图单位换算核实）</option>
        </select>
      </Field>
      {technical.items.map((i: any, n: number) => (
        <fieldset key={i.lineKey}>
          <legend>
            {i.lineKey} · {i.kind}
          </legend>
          <div className="form-grid">
            {[
              ["widthMm", "外框宽度 mm"],
              ["heightMm", "外框高度 mm"],
              ["quantity", "数量"],
            ].map(([k, label]) => (
              <Field key={k} label={label}>
                <input
                  type="number"
                  required
                  min="0.01"
                  step="any"
                  value={i[k]}
                  onChange={(e) =>
                    line(
                      n,
                      k,
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                />
              </Field>
            ))}
            {[
              ["openingWidthMm", "洞口宽 mm"],
              ["openingHeightMm", "洞口高 mm"],
              ["leafWidthMm", "扇宽 mm"],
              ["leafHeightMm", "扇高 mm"],
              ["depthMm", "构件深度 mm（平面轮廓）"],
            ].map(([k, label]) => (
              <Field key={k} label={label}>
                <input
                  type="number"
                  min="0.01"
                  step="any"
                  value={details[i.lineKey][k] ?? ""}
                  onChange={(e) =>
                    setDetails({
                      ...details,
                      [i.lineKey]: {
                        ...details[i.lineKey],
                        [k]:
                          e.target.value === "" ? null : Number(e.target.value),
                      },
                    })
                  }
                />
              </Field>
            ))}
            {[
              ["viewDirection", "观察方向（例：室内向外看，须核实）"],
              ["location", "所在位置（内部）"],
              ["evidence", "尺寸依据（原图页码/区域或DXF实体编号）"],
            ].map(([k, label]) => (
              <Field key={k} label={label}>
                <input
                  required={k !== "location"}
                  value={details[i.lineKey][k]}
                  onChange={(e) =>
                    setDetails({
                      ...details,
                      [i.lineKey]: {
                        ...details[i.lineKey],
                        [k]: e.target.value,
                      },
                    })
                  }
                />
              </Field>
            ))}
          </div>
          <details>
            <summary>全部技术配置（包含升级后配置和认证要求）</summary>
            <div className="form-grid">
              {Object.entries(TC_FIELDS).map(([k, label]) => (
                <Field key={k} label={label}>
                  <textarea
                    value={i.fields[k]}
                    onChange={(e) =>
                      line(n, "fields", { ...i.fields, [k]: e.target.value })
                    }
                  />
                </Field>
              ))}
            </div>
          </details>
        </fieldset>
      ))}
      <Field label="工程设计依据 / 待补型材节点及公差">
        <textarea value={basis} onChange={(e) => setBasis(e.target.value)} />
      </Field>
      <Field label="问题清单 / 批注">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Field label="本次生成或修改原因">
        <input
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <label>
        <input
          required
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        已核实单位、比例及输入尺寸；未从不明比例的图片推算生产尺寸
      </label>
      <button disabled={m.busy}>
        {m.busy ? "正在生成真实DXF…" : "生成可编辑深化草稿"}
      </button>
    </form>
  );
}
function Version({
  id,
  canReview,
  refresh,
}: {
  id: string;
  canReview: boolean;
  refresh: () => void;
}) {
  const r = useResource<any>("/supply/cad/versions/" + id),
    m = useMutation(),
    [note, setNote] = useState(""),
    [dim, setDim] = useState(false),
    [privacy, setPrivacy] = useState(false),
    [decision, setDecision] = useState("approved_draft"),
    [mo, setMo] = useState("");
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  const v = r.data;
  return (
    <section className="card">
      <h3>
        深化草稿 V{v.version} · {v.reviews[0]?.decision || "待审核"}
      </h3>
      <p>
        创建：{v.created_at}；引用TC：
        <Link to={"/technical/" + v.tc_id}>查看对应TC版本</Link>
        。草稿技术审核不等于客户签认或生产批准。
      </p>
      <ErrorBox message={m.error || v.staleReason} />
      {v.issues.length > 0 ? (
        <div role="alert">
          <h4>与TC的技术差异，必须处理</h4>
          <ul>
            {v.issues.map((s: string) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p>
          本版外框、数量、配置与引用TC一致；洞口/扇尺寸及工程设计依据仍需人工审核。
        </p>
      )}
      <Viewer analysis={v.output.analysis} />
      <details>
        <summary>参数、问题清单和历史差异</summary>
        <p>{v.parameters.notes || "暂无批注"}</p>
        <p>{v.parameters.engineeringBasis || "工程设计依据待补"}</p>
        {v.previousParameters && (
          <p>
            {JSON.stringify(v.previousParameters) ===
            JSON.stringify(v.parameters)
              ? "参数与上一版相同"
              : "参数已变化，需重新审核。下表为本版已保存参数。"}
          </p>
        )}
        <div className="cad-table">
          <table>
            <thead>
              <tr>
                <th>行</th>
                <th>外框 mm</th>
                <th>数量</th>
                <th>来源定位 / 观察方向</th>
              </tr>
            </thead>
            <tbody>
              {v.parameters.technical.items.map((i: any) => (
                <tr key={i.lineKey}>
                  <td>{i.lineKey}</td>
                  <td>
                    {i.widthMm} × {i.heightMm}
                  </td>
                  <td>{i.quantity}</td>
                  <td>
                    {v.parameters.details[i.lineKey]?.evidence} /{" "}
                    {v.parameters.details[i.lineKey]?.viewDirection}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <div className="quote-toolbar">
        {["dxf", "pdf", "svg", "json"].map((f) => (
          <a
            key={f}
            href={"/api/supply/cad/versions/" + id + "/export/" + f}
            target="_blank"
            rel="noreferrer"
          >
            下载内部草稿 {f.toUpperCase()}
          </a>
        ))}
      </div>
      {canReview && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void m.run(
                "/supply/cad/versions/" + id + "/review",
                "POST",
                {
                  decision,
                  note,
                  dimensionsChecked: dim,
                  privacyChecked: privacy,
                },
                refresh,
              );
            }}
          >
            <Field label="技术审核结论">
              <select
                value={decision}
                onChange={(e) => setDecision(e.target.value)}
              >
                <option value="approved_draft">
                  通过草稿技术审核（不可投产）
                </option>
                <option value="rejected">驳回</option>
                <option value="withdrawn">撤回并停止本版下载</option>
              </select>
            </Field>
            <Field label="审核意见">
              <textarea
                required
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <label>
              <input
                type="checkbox"
                checked={dim}
                onChange={(e) => setDim(e.target.checked)}
              />
              已检查尺寸、方向、数量及全部配置
            </label>
            <label>
              <input
                type="checkbox"
                checked={privacy}
                onChange={(e) => setPrivacy(e.target.checked)}
              />
              已检查图中文字、图层、图块、元数据及隐私
            </label>
            <button disabled={m.busy}>保存技术审核</button>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void m.run(
                "/supply/cad/versions/" + id + "/link-mo",
                "POST",
                { moDraftId: mo },
                refresh,
              );
            }}
          >
            <Field label="选择同TC版本的MO草稿">
              <select
                required
                value={mo}
                onChange={(e) => setMo(e.target.value)}
              ><option value="">请选择已创建的MO草稿</option>{v.moDrafts?.map((d:any)=><option key={d.id} value={d.id}>{d.id.slice(0,8)} · {d.created_at}</option>)}</select>
            </Field>
            {!v.moDrafts?.length&&<p>暂无对应MO草稿。请先完成<Link to={'/technical/'+v.tc_id}>本版本客户签认</Link>及原有WO/PO等门禁，再从TC创建MO草稿。</p>}
            <button disabled={m.busy || !mo || !!v.staleReason}>关联MO草稿（不下达）</button>
          </form>
        </>
      )}
      <p>
        工厂CAD下载未开放：当前缺少公司批准的生产节点模板及独立CAD软件验收，不允许以草稿外发生产。
      </p>
    </section>
  );
}
