import { useState, type PointerEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useResource } from "./api.ts";
import { ErrorBox, Field, Loading } from "./ui.tsx";
type Mask = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
async function fileData(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let b = "";
  for (let i = 0; i < bytes.length; i += 32768)
    b += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(b);
}
export function TcDrawings({
  tcId,
  lineKeys,
}: {
  tcId: string;
  lineKeys: string[];
}) {
  const [rev, setRev] = useState(0),
    r = useResource<any>(`/supply/technical/${tcId}/drawings`, rev),
    m = useMutation(),
    [file, setFile] = useState<File | null>(null),
    [keys, setKeys] = useState<string[]>([]);
  return (
    <section className="card">
      <h3>图纸脱敏审核</h3>
      <p>
        原图仅内部可见。先上传原图并关联产品行，制作脱敏副本，经授权技术人员或管理员逐页审核后随MO下达。TC签字后原图不能增加或更换，须升版重签。
      </p>
      <ErrorBox message={r.error || m.error} />
      {r.loading ? (
        <Loading />
      ) : (
        <>
          {r.data?.canUpload && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!file) return;
                void fileData(file)
                  .then((data) =>
                    m.run(
                      `/supply/technical/${tcId}/drawings`,
                      "POST",
                      {
                        name: file.name,
                        mime: file.type,
                        data,
                        lineKeys: keys,
                      },
                      () => {
                        setFile(null);
                        setRev((n) => n + 1);
                      },
                    ),
                  )
                  .catch(() => m.setError("读取图纸失败，请重新选择文件"));
              }}
            >
              <Field label="内部原图（PDF/PNG/JPEG，4MB内，PDF最多5页）">
                <input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg"
                  required
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f && f.size > 4 * 1024 * 1024) {
                      m.setError("文件超过4MB");
                      setFile(null);
                    } else {
                      m.setError("");
                      setFile(f ?? null);
                    }
                  }}
                />
              </Field>
              <fieldset>
                <legend>对应TC产品行</legend>
                {lineKeys.map((k) => (
                  <label key={k}>
                    <input
                      type="checkbox"
                      checked={keys.includes(k)}
                      onChange={(e) =>
                        setKeys(
                          e.target.checked
                            ? [...keys, k]
                            : keys.filter((x) => x !== k),
                        )
                      }
                    />
                    {k}{" "}
                  </label>
                ))}
              </fieldset>
              <button disabled={m.busy || !file || !keys.length}>
                上传内部原图
              </button>
            </form>
          )}
          {r.data?.rows.length === 0 && (
            <p>尚未上传图纸；没有使用空白或模拟附件。</p>
          )}
          {r.data?.rows.map((d: any) => (
            <p key={d.id}>
              <Link to={`/technical/drawings/${d.id}`}>{d.name}</Link> ·{" "}
              {d.page_count}页 ·{" "}
              {d.version ? `副本V${d.version}` : "尚未制作副本"} ·{" "}
              {d.approved === true
                ? "已审核"
                : d.approved === false
                  ? "已驳回"
                  : "待审核"}{" "}
              {d.reviewer &&
                ` · ${d.reviewer} · ${new Date(d.reviewed_at).toLocaleString()}`}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
export default function DrawingEditor() {
  const { id } = useParams(),
    [rev, setRev] = useState(0),
    r = useResource<any>(`/supply/technical-drawings/${id}`, rev),
    m = useMutation();
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  return (
    <Editor
      key={`${id}:${rev}`}
      d={r.data}
      mutate={m}
      done={() => setRev((n) => n + 1)}
    />
  );
}
function Editor({
  d,
  mutate: m,
  done,
}: {
  d: any;
  mutate: ReturnType<typeof useMutation>;
  done: () => void;
}) {
  const latest = d.versions[0],
    [page, setPage] = useState(0),
    [masks, setMasks] = useState<Mask[]>(latest?.rectangles ?? []),
    [start, setStart] = useState<{ x: number; y: number } | null>(null),
    [reason, setReason] = useState(""),
    [note, setNote] = useState(""),
    [reviewed, setReviewed] = useState<number[]>([]),
    [privacy, setPrivacy] = useState(false),
    [technical, setTechnical] = useState(false),
    [draw, setDraw] = useState(true);
  const point = (e: PointerEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)),
      y: Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)),
    };
  };
  return (
    <section className="card">
      <Link to={`/technical/${d.tcId}`}>返回TC</Link>
      <h2>图纸脱敏与人工审核</h2>
      <p>
        内部原文件：{d.name} ·{" "}
        <a href={`/api/supply/technical-drawings/${d.id}/original`}>
          内部下载原图
        </a>
      </p>
      <p>
        拖动框选客户名称、电话、邮箱、地址、签字等区域。副本由服务器重新生成图片，去掉原文字层及元数据；这不是自动识别，必须人工逐页检查尺寸和技术内容未损坏。DWG等格式请先导出PDF。
      </p>
      <ErrorBox message={m.error} />
      {d.superseded && (
        <p role="alert">源TC已升版，请使用新TC图纸；此处保留历史记录。</p>
      )}
      <Field label="图纸页">
        <select
          value={page}
          onChange={(e) => {
            setPage(Number(e.target.value));
            setStart(null);
          }}
        >
          {d.pages.map((_: any, i: number) => (
            <option key={i} value={i}>
              第{i + 1}页
            </option>
          ))}
        </select>
      </Field>
      <label>
        <input
          type="checkbox"
          checked={draw}
          onChange={(e) => setDraw(e.target.checked)}
        />
        框选遮盖模式（关闭后可滚动查看）
      </label>
      <div
        data-testid="drawing-mask-surface"
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 1000,
          touchAction: draw ? "none" : "auto",
          cursor: draw ? "crosshair" : "default",
          border: "1px solid #999",
        }}
        onPointerDown={(e) => {
          if (!draw) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setStart(point(e));
        }}
        onPointerUp={(e) => {
          if (!start || !draw) return;
          const p = point(e),
            rect = {
              page,
              x: Math.min(start.x, p.x),
              y: Math.min(start.y, p.y),
              width: Math.abs(start.x - p.x),
              height: Math.abs(start.y - p.y),
            };
          if (rect.width > 0.002 && rect.height > 0.002)
            setMasks([...masks, rect]);
          setStart(null);
        }}
        onPointerCancel={() => setStart(null)}
      >
        <img
          alt={`内部原图第${page + 1}页`}
          src={`/api/supply/technical-drawings/${d.id}/pages/${page}`}
          draggable={false}
          style={{ width: "100%", display: "block", pointerEvents: "none" }}
        />
        {masks
          .filter((v) => v.page === page)
          .map((v, i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                left: `${v.x * 100}%`,
                top: `${v.y * 100}%`,
                width: `${v.width * 100}%`,
                height: `${v.height * 100}%`,
                background: "#000",
                pointerEvents: "none",
              }}
            />
          ))}
      </div>
      <p>当前共{masks.length}处遮盖；只保存副本，不修改原图。</p>
      <button
        type="button"
        disabled={!masks.length}
        onClick={() => setMasks(masks.slice(0, -1))}
      >
        撤销最后遮盖
      </button>{" "}
      <button
        type="button"
        onClick={() => setMasks(masks.filter((v) => v.page !== page))}
      >
        清除本页遮盖
      </button>
      <Field label="副本变更原因">
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <button
        disabled={m.busy || !reason.trim() || d.superseded}
        onClick={() =>
          void m.run(
            `/supply/technical-drawings/${d.id}/redactions`,
            "POST",
            { baseVersion: latest?.version ?? 0, rectangles: masks, reason },
            done,
          )
        }
      >
        生成新脱敏副本（重新审核）
      </button>
      {latest && (
        <>
          <h3>
            服务端副本 V{latest.version} ·{" "}
            {latest.approved === true
              ? "审核通过"
              : latest.approved === false
                ? "审核驳回"
                : "待审核"}
          </h3>
          <p>
            下面显示已保存的真实副本，审核不针对上方未保存的遮盖。请逐页打开大图核查。
          </p>
          {d.pages.map((_: any, i: number) => (
            <div key={i} className="card">
              <a
                target="_blank"
                rel="noreferrer"
                href={`/api/supply/drawing-redactions/${latest.id}/pages/${i}`}
              >
                打开第{i + 1}页副本大图
              </a>
              <img
                alt={`脱敏副本第${i + 1}页`}
                src={`/api/supply/drawing-redactions/${latest.id}/pages/${i}`}
                style={{ display: "block", width: "100%", maxWidth: 900 }}
              />
              {d.canReview && latest.approved === null && (
                <label>
                  <input
                    type="checkbox"
                    checked={reviewed.includes(i)}
                    onChange={(e) =>
                      setReviewed(
                        e.target.checked
                          ? [...reviewed, i]
                          : reviewed.filter((x) => x !== i),
                      )
                    }
                  />
                  已核查第{i + 1}页
                </label>
              )}
            </div>
          ))}
          {d.canReview && latest.approved === null && !d.superseded && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={privacy}
                  onChange={(e) => setPrivacy(e.target.checked)}
                />
                客户身份、联系方式、地址和签字已去除
              </label>
              <br />
              <label>
                <input
                  type="checkbox"
                  checked={technical}
                  onChange={(e) => setTechnical(e.target.checked)}
                />
                尺寸、结构及技术要求完整保留
              </label>
              <Field label="审核意见">
                <input value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <button
                disabled={
                  m.busy ||
                  !note.trim() ||
                  !privacy ||
                  !technical ||
                  reviewed.length !== d.pages.length
                }
                onClick={() =>
                  void m.run(
                    `/supply/drawing-redactions/${latest.id}/review`,
                    "POST",
                    {
                      approved: true,
                      note,
                      reviewedPages: reviewed,
                      privacyRemoved: privacy,
                      technicalPreserved: technical,
                    },
                    done,
                  )
                }
              >
                审核通过此副本
              </button>{" "}
              <button
                disabled={m.busy || !note.trim()}
                onClick={() =>
                  void m.run(
                    `/supply/drawing-redactions/${latest.id}/review`,
                    "POST",
                    {
                      approved: false,
                      note,
                      reviewedPages: reviewed,
                      privacyRemoved: privacy,
                      technicalPreserved: technical,
                    },
                    done,
                  )
                }
              >
                驳回此副本
              </button>
            </>
          )}
          <h3>副本与审核历史</h3>
          {d.versions.map((v: any) => (
            <p key={v.id}>
              V{v.version} · {v.reason} ·{" "}
              {v.approved === true
                ? "通过"
                : v.approved === false
                  ? "驳回"
                  : "待审"}{" "}
              · {v.reviewer ?? "尚无审核人"}{" "}
              {v.reviewed_at ? new Date(v.reviewed_at).toLocaleString() : ""} ·{" "}
              {v.note ?? ""}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
