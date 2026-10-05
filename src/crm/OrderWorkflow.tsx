import { useState } from "react";
import {Link} from 'react-router-dom';
import { useMutation } from "./api.ts";
import { useSession } from "./context.tsx";
import { ErrorBox, Field, Panel } from "./ui.tsx";

const conditions = [
  ["informationComplete", "资料完整"],
  ["formalQuoteIssued", "正式报价已发布"],
  ["depositReceived", "定金到账"],
  ["measurementUploaded", "量尺记录已上传"],
  ["finalDimensionsConfirmed", "最终尺寸已确认"],
  ["productionInstructionIssued", "生产指令已下达"],
  ["outgoingInspectionPassed", "出货检验通过"],
  ["shipmentRecorded", "全部产品已发货"],
  ["installationConfirmed", "安装已确认"],
] as const;
export type Workflow = {
  chain?:{work_order_id:string;current_stage:string;dimensions_locked:boolean;ready:boolean}|null;
  state: string;
  projectId: string;
  evidence: Record<string, boolean>;
  records: { id: string; kind: string; created_at: string }[];
  events: {
    id: string;
    from_state: string;
    to_state: string;
    created_at: string;
    basis: { label: string };
  }[];
};
type Item = { id: string; line_key: string; quantity: number };
export function OrderWorkflow({
  id,
  data,
  items,
}: {
  id: string;
  data: Workflow;
  items: Item[];
}) {
  const { user, refresh, notify } = useSession(),
    m = useMutation(),
    upload = useMutation();
  const [amount, setAmount] = useState(""),
    [currency, setCurrency] = useState("USD"),
    [received, setReceived] = useState(""),
    [reference, setReference] = useState("");
  const [note, setNote] = useState(""),
    [fileId, setFileId] = useState(""),
    [fileName, setFileName] = useState(""),
    [kind, setKind] = useState<"measurement" | "installation">("measurement");
  const [dimensions, setDimensions] = useState<
    Record<string, { width: string; height: string }>
  >({});
  const latestMeasurement = data.records.findLast(
    (r) => r.kind === "measurement",
  );
  const busy = m.busy || upload.busy;
  const instructionReady = conditions
    .slice(0, 5)
    .every(([key]) => data.evidence[key]) && data.chain?.ready===true;
  const save = (body: unknown) =>
    void m.run(`/supply/orders/${id}/evidence`, "POST", body, () => {
      refresh();
      notify("订单证据已保存，状态已由服务器核验");
    });
  async function readFile(file: File) {
    setFileId("");
    setFileName("");
    upload.setError("");
    if (
      file.size > 2e6 ||
      !["application/pdf", "image/png", "image/jpeg"].includes(file.type)
    ) {
      upload.setError("请选择小于2MB的PDF、PNG或JPEG文件");
      return;
    }
    try {
      const fileData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsDataURL(file);
      });
      await upload.run<{ id: string }>(
        `/quoting/projects/${data.projectId}/files`,
        "POST",
        { name: file.name, mime: file.type, data: fileData, kind: "reference" },
        (r) => {
          setFileId(r.id);
          setFileName(file.name);
        },
      );
    } catch (e) {
      upload.setError(e instanceof Error ? e.message : "附件上传失败");
    }
  }
  return (
    <Panel title="订单履约条件与证据">
      <h3>业务阶段：{data.state}</h3>
      <p>
        财务收款确认后先签发WO再开PO。量尺、最终尺寸、正式MO和IQC齐备后才能生产；物流签收不等于安装完结。
      </p>
      <ul>
        {conditions.map(([key, label]) => (
          <li key={key}>
            {data.evidence[key] ? "已完成" : "待完成"} · {label}
          </li>
        ))}
      </ul>
      {user.role === "admin" ? (
        <>
          <form
            className="supply-actions"
            onSubmit={(e) => {
              e.preventDefault();
              save({
                kind: "deposit",
                amount: Number(amount),
                currency,
                receivedAt: new Date(received).toISOString(),
                reference,
              });
            }}
          >
            <h3>登记定金到账</h3>
            <Field label="到账金额">
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="到账币种">
              <input
                required
                pattern="[A-Z]{3}"
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="实际到账时间">
              <input
                required
                type="datetime-local"
                value={received}
                onChange={(e) => setReceived(e.target.value)}
              />
            </Field>
            <Field label="到账凭据或银行流水说明">
              <input
                required
                minLength={2}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
            <button disabled={busy}>确认定金已到账</button>
          </form>
          <h3>量尺与安装证明</h3>
          <Field label="证明类型">
            <select
              value={kind}
              disabled={busy}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="measurement">量尺记录</option>
              <option value="installation">安装确认</option>
            </select>
          </Field>
          <Field label="上传订单证明（PDF、PNG、JPEG，2MB以内）">
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void readFile(file);
              }}
            />
          </Field>
          {fileName && <p>附件已上传：{fileName}；请继续登记证据。</p>}
          <Field label="核验说明">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <button
            disabled={
              busy ||
              !fileId ||
              note.trim().length < 2 ||
              (kind === "measurement" &&
                data.evidence.productionInstructionIssued) ||
              (kind === "installation" && !data.evidence.shipmentRecorded)
            }
            onClick={() =>
              save({
                kind,
                fileId,
                note,
                ...(kind === "installation"
                  ? { confirmedAt: new Date().toISOString() }
                  : {}),
              })
            }
          >
            登记{kind === "measurement" ? "量尺记录" : "安装确认"}
          </button>
          <h3>逐项确认最终尺寸（毫米）</h3>
          <p>请根据最新量尺记录填写，不会自动沿用报价估算尺寸。</p>
          {items.map((item) => (
            <div className="supply-actions" key={item.id}>
              <b>
                {item.line_key} · {item.quantity} 件
              </b>
              <Field label={`${item.line_key} 最终宽度 mm`}>
                <input
                  type="number"
                  min="0.01"
                  max="100000"
                  value={dimensions[item.id]?.width || ""}
                  onChange={(e) =>
                    setDimensions((v) => ({
                      ...v,
                      [item.id]: {
                        width: e.target.value,
                        height: v[item.id]?.height || "",
                      },
                    }))
                  }
                />
              </Field>
              <Field label={`${item.line_key} 最终高度 mm`}>
                <input
                  type="number"
                  min="0.01"
                  max="100000"
                  value={dimensions[item.id]?.height || ""}
                  onChange={(e) =>
                    setDimensions((v) => ({
                      ...v,
                      [item.id]: {
                        height: e.target.value,
                        width: v[item.id]?.width || "",
                      },
                    }))
                  }
                />
              </Field>
            </div>
          ))}
          <button
            disabled={
              busy ||
              !latestMeasurement ||
              data.evidence.productionInstructionIssued ||
              note.trim().length < 2 ||
              items.some(
                (i) =>
                  !(
                    Number(dimensions[i.id]?.width) > 0 &&
                    Number(dimensions[i.id]?.height) > 0
                  ),
              )
            }
            onClick={() =>
              save({
                kind: "dimensions",
                measurementId: latestMeasurement?.id,
                note,
                lines: items.map((i) => ({
                  itemId: i.id,
                  widthMm: Number(dimensions[i.id].width),
                  heightMm: Number(dimensions[i.id].height),
                })),
              })
            }
          >
            确认全部最终尺寸
          </button>
          <h3>正式下达生产指令</h3>
          <p><Link to={data.chain?`/supply/chain/${data.chain.work_order_id}`:'/supply/chain'}>进入订单履约链核实WO、MO与IQC</Link></p>
          {!data.chain?.ready&&!data.evidence.productionInstructionIssued&&<p>尚须完成：已签发WO、全部有效PO对应的MO，以及原材料备齐/IQC核验。</p>}
          {!instructionReady && (
            <p role="status">
              尚缺：
              {conditions
                .slice(0, 5)
                .filter(([key]) => !data.evidence[key])
                .map(([, label]) => label)
                .join("、")}
            </p>
          )}
          <button
            className="primary"
            disabled={
              busy ||
              !instructionReady ||
              data.evidence.productionInstructionIssued ||
              note.trim().length < 2
            }
            onClick={() => save({ kind: "instruction", note })}
          >
            正式下达生产指令
          </button>
          <p>
            下达后锁定量尺和最终尺寸；此操作不发送外部通知。核验说明至少填写2字。
          </p>
          <ErrorBox message={m.error || upload.error} />
        </>
      ) : (
        <p>证据登记与正式投产由管理员核验。本页仅显示您获授权订单的状态。</p>
      )}
      <h3>状态变更记录</h3>
      {data.events.length ? (
        <ol>
          {data.events.map((event) => (
            <li key={event.id}>
              {event.from_state} → {event.to_state} · {event.basis.label} ·{" "}
              {new Date(event.created_at).toLocaleString()}
            </li>
          ))}
        </ol>
      ) : (
        <p>暂无核验记录，历史订单不会自动视为条件齐备。</p>
      )}
    </Panel>
  );
}
