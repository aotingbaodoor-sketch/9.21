import { useState } from "react";
import { useResource, useMutation } from "./api.ts";
import { Field, ErrorBox, Loading } from "./ui.tsx";
import { CAD_STATES, cadSvg } from "../../shared/cad.ts";

export function CadRelease({
  version,
  refresh,
}: {
  version: any;
  refresh: () => void;
}) {
  const r = useResource<any>("/supply/cad/versions/" + version.id + "/release"),
    m = useMutation();
  const [note, setNote] = useState(""),
    [files, setFiles] = useState<Record<string, string>>({}),
    [report, setReport] = useState<Record<string, any>>({});
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  const d = r.data,
    base = "/supply/cad/versions/" + version.id;
  const act = (path: string, body: any) =>
    void m.run(base + path, "POST", body, refresh);
  return (
    <section className="card">
      <h3>审核与生产批准 · {CAD_STATES[d.state]}</h3>
      <ErrorBox message={m.error} />
      <p>
        技术审核由技术人员/管理员执行；生产批准仅管理员执行。必须有真实客户签认和工程依据。批准不会自动下达MO或向工厂发送。
      </p>
      {["draft", "reviewed"].includes(d.state) && (
        <button
          disabled={m.busy || !!version.staleReason}
          onClick={() => act("/submit", {})}
        >
          提交审核
        </button>
      )}
      {d.canReview && (
        <details>
          <summary>补齐生产资料包（不是把外框草稿批准生产）</summary>
          <p>
            先在上方上传实际完成DXF、型材、安装节点、公差依据、独立CAD验收记录，再生成新版本。资料更新会使旧审核失效。完成DXF先点击“分析”，取得对应宽/高原生尺寸实体编号。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              act("/production-packet", {
                ...files,
                note,
                report: version.parameters.technical.items.map((i: any) => ({
                  lineKey: i.lineKey,
                  ...report[i.lineKey],
                  dimensions: true,
                  materials: true,
                  quantity: true,
                  configuration: true,
                })),
              });
            }}
          >
            <div className="form-grid">
              {[
                ["drawingSourceId", "可编辑生产完成图（DXF）"],
                ["profileSourceId", "公司认可型材/五金资料"],
                ["nodeSourceId", "安装节点/剖面依据"],
                ["toleranceSourceId", "加工公差及适用条件"],
                ["inspectionSourceId", "独立CAD验收记录（PDF或图片）"],
              ].map(([key, label]) => (
                <Field key={key} label={label}>
                  <select
                    required
                    value={files[key] || ""}
                    onChange={(e) =>
                      setFiles({ ...files, [key]: e.target.value })
                    }
                  >
                    <option value="">请选择实际文件</option>
                    {d.sources
                      .filter(
                        (s: any) =>
                          key !== "drawingSourceId" || s.format === "dxf",
                      )
                      .map((s: any) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </Field>
              ))}
            </div>
            {version.parameters.technical.items.map((i: any) => (
              <fieldset key={i.lineKey}>
                <legend>
                  {i.lineKey} · TC {i.widthMm}×{i.heightMm}mm · {i.quantity}件
                </legend>
                {[
                  ["widthEntityId", "完成图宽度标注实体编号"],
                  ["heightEntityId", "完成图高度标注实体编号"],
                  [
                    "drawingEvidence",
                    "数量、材料及最终配置的图中定位/核对记录",
                  ],
                ].map(([key, label]) => (
                  <Field key={key} label={label}>
                    <input
                      required
                      value={report[i.lineKey]?.[key] || ""}
                      onChange={(e) =>
                        setReport({
                          ...report,
                          [i.lineKey]: {
                            ...report[i.lineKey],
                            [key]: e.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                ))}
              </fieldset>
            ))}
            <Field label="工程核验说明（型材适用性、节点、公差、独立CAD检查结果）">
              <textarea
                required
                minLength={10}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <label>
              <input type="checkbox" required />
              已逐项人工核对数量、材料、配置和工程依据；不以勾选代替实际检查
            </label>
            <button
              disabled={
                m.busy ||
                !!version.staleReason ||
                ["production_approved", "void"].includes(d.state)
              }
            >
              保存资料并重新审核
            </button>
          </form>
        </details>
      )}
      {d.packet ? (
        <>
          <p>
            生产资料包保存于 {new Date(d.packet.created_at).toLocaleString()}
            。下图为重新构造并去除原文件元数据的候选生产图，须对照原图核验。
          </p>
          <img
            alt="脱敏生产候选图"
            style={{ maxWidth: "100%" }}
            src={
              "data:image/svg+xml;charset=utf-8," +
              encodeURIComponent(cadSvg(d.packet.analysis.primitives))
            }
          />
          {d.canReview && (
            <p>
              {["pdf", "dxf"].map((f) => (
                <a
                  key={f}
                  style={{ marginRight: 16 }}
                  href={"/api" + base + "/packet-preview/" + f}
                  target="_blank"
                  rel="noreferrer"
                >
                  内部待审核预览 {f.toUpperCase()}
                </a>
              ))}
            </p>
          )}
        </>
      ) : (
        <p role="status">
          生产批准尚缺：实际完成DXF、型材/节点/公差依据和独立CAD验收记录。自动生成的外框草稿不能代替这些资料。
        </p>
      )}
      {d.canApprove && d.state === "reviewed" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act("/approve-production", { note });
          }}
        >
          <Field label="生产批准依据">
            <textarea
              required
              minLength={10}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <button disabled={m.busy || !d.packet || !!version.staleReason}>
            批准用于生产（不下达、不发送）
          </button>
        </form>
      )}
      {d.state === "production_approved" && !version.staleReason && (
        <p>
          {["dxf", "pdf"].map((f) => (
            <a
              key={f}
              style={{ marginRight: 16 }}
              href={"/api" + base + "/approved/" + f}
            >
              下载批准图 {f.toUpperCase()}
            </a>
          ))}
        </p>
      )}
      {d.canReview && d.state !== "void" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act("/void", { note });
          }}
        >
          <Field label="撤回/作废原因">
            <input
              required
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <button disabled={m.busy}>作废并停止生产图下载</button>
        </form>
      )}
      <details>
        <summary>状态与操作记录</summary>
        <ul>
          {d.history.map((h: any, n: number) => (
            <li key={n}>
              {CAD_STATES[h.state]} · {h.name} ·{" "}
              {new Date(h.created_at).toLocaleString()} · {h.note}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
