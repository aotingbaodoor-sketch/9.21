import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { ErrorBox, Loading, Field } from "./ui.tsx";

type Item = {
  id: string;
  doc_no: string;
  company: string;
  customer_code: string;
  customer_id: string;
  order_number: string;
  current_stage: string;
  trade_term: string;
  expected_delivery: string;
};
type File = { id: string; name: string };
const labels: Record<string, string> = {
  profile: "型材 / Profile",
  glass: "玻璃 / Glass",
  hardware: "五金 / Hardware",
  finish: "表面处理 / Finish",
  sampleReference: "封样依据 / Sample",
  packing: "包装要求 / Packing",
  requiredDate: "要求完工日",
};
export default function OrderChain() {
  const { id } = useParams();
  return id ? <ChainDetail id={id} /> : <ChainList />;
}
function ChainList() {
  const { user, revision, refresh } = useSession();
  const r = useResource<{
    orders: Item[];
    candidates: {
      id: string;
      order_number: string;
      company: string;
      project_id: string;
    }[];
  }>("/supply/chain", revision);
  const [selected, setSelected] = useState("");
  if (r.loading) return <Loading />;
  const candidate = r.data?.candidates.find((c) => c.id === selected);
  return (
    <>
      <ErrorBox message={r.error} />
      <section className="card">
        <h2>订单履约链</h2>
        <p>客户编号贯穿 · WO → PO → MO。旧订单与履约页面仍保留。</p>
        <p className="muted">
          当前已开放工单、采购、生产指令、IQC和投产前段，以及物流回传登记。后续验收、放单、变更及关闭尚未开放，不会自动标记完成。
        </p>
        <p>
          <Link to="/supply">原订单与履约</Link> ·{" "}
          <Link to="/quotations">报价、确认与定金</Link>
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>工单号</th>
                <th>客户编号</th>
                <th>客户</th>
                <th>销售订单</th>
                <th>当前节点</th>
                <th>交期</th>
              </tr>
            </thead>
            <tbody>
              {r.data?.orders.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/supply/chain/${o.id}`}>{o.doc_no}</Link>
                  </td>
                  <td>{o.customer_code}</td>
                  <td>{o.company}</td>
                  <td>{o.order_number}</td>
                  <td>{o.current_stage}</td>
                  <td>{o.expected_delivery}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!r.data?.orders.length && (
          <p>尚无已签发工单。不会用样例记录代替真实订单。</p>
        )}
      </section>
      {user.role === "admin" && (
        <section className="card">
          <h2>签发订单交付工单 WO</h2>
          <p>
            须已有定金到账确认、SO和本项目的客户确认附件。签发后编号永久保存。
          </p>
          <Field label="选择销售订单">
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">请选择</option>
              {r.data?.candidates.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.order_number} · {o.company}
                </option>
              ))}
            </select>
          </Field>
          {!r.data?.candidates.length && (
            <p>
              暂无可开工单的销售订单。请先在报价详情确认报价、登记真实定金并开立SO。
            </p>
          )}
          {candidate && (
            <CreateWorkOrder
              key={candidate.id}
              candidate={candidate}
              done={() => {
                setSelected("");
                refresh();
              }}
            />
          )}
        </section>
      )}
    </>
  );
}
function CreateWorkOrder({
  candidate,
  done,
}: {
  candidate: { id: string; project_id: string };
  done: () => void;
}) {
  const m = useMutation(),
    r = useResource<any>(`/quoting/projects/${candidate.project_id}`);
  const [file, setFile] = useState(""),
    [due, setDue] = useState(""),
    [orderType, setType] = useState("bulk");
  const files: File[] = r.data?.files ?? [];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.run(
          "/supply/chain",
          "POST",
          {
            salesOrderId: candidate.id,
            confirmationFileId: file,
            expectedDelivery: due,
            orderType,
            tradeTerm: "FOB",
          },
          done,
        );
      }}
    >
      <ErrorBox message={r.error || m.error} />
      <Field label="客户确认凭证">
        <select required value={file} onChange={(e) => setFile(e.target.value)}>
          <option value="">请选择本项目已上传文件</option>
          {files.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>
      <p>
        <Link to={`/quotations/${candidate.project_id}`}>
          前往报价项目上传确认附件
        </Link>
      </p>
      <Field label="期望交期">
        <input
          required
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
      </Field>
      <Field label="订单类型">
        <select value={orderType} onChange={(e) => setType(e.target.value)}>
          <option value="bulk">大货单</option>
          <option value="sample">样品单</option>
          <option value="replacement">补件单</option>
        </select>
      </Field>
      <p>贸易术语：FOB。EXW报关适用规则待确认，当前不能启用。</p>
      <button className="primary" disabled={m.busy || !files.length}>
        核实凭证并签发WO
      </button>
    </form>
  );
}
function ChainDetail({ id }: { id: string }) {
  const { user, revision, refresh } = useSession(),
    r = useResource<any>(`/supply/chain/${id}`, revision),
    m = useMutation();
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  const {
    order: w,
    progress,
    events,
    purchases,
    instructions,
    files,
    logistics,
    docTypes,
    notices,
  } = r.data;
  return (
    <>
      <ErrorBox message={r.error || m.error} />
      <section className="card">
        <Link to="/supply/chain">← 工单列表</Link>
        <h2>
          {w.doc_no} · {w.company}
        </h2>
        <p>
          客户编号：
          <Link to={`/customers/${w.customer_id}`}>{w.customer_code}</Link>
          　销售订单：{w.order_number}　{w.trade_term}　交期：
          {w.expected_delivery}
        </p>
        <p>编号不可编辑；内部工单不可直接发给工厂。工厂仅获取专用PO/MO版本。</p>
        <Link to="/supply">打开原订单页面开立采购订单</Link>
      </section>
      <section className="card">
        <h2>22态履约进度</h2>
        <p>尚未完成验收的后续节点保持待办，不自动推成“已完成”。</p>
        {user.role === "admin" &&
          ["po_issued", "material_ready"].includes(w.current_stage) && (
            <ProductionStart order={w} files={files} done={refresh} />
          )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>序</th>
                <th>节点</th>
                <th>状态</th>
                <th>客户通知级别</th>
                <th>完成时间</th>
              </tr>
            </thead>
            <tbody>
              {progress.map((p: any) => (
                <tr key={p.code}>
                  <td>{p.ordinal}</td>
                  <td>{p.name_cn}</td>
                  <td>
                    {p.status === "completed"
                      ? "已完成"
                      : p.status === "n/a"
                        ? `不适用：${p.skip_reason}`
                        : "待办"}
                  </td>
                  <td>
                    {
                      { required: "必报", notify: "告知", none: "不对外" }[
                        p.visibility as "required" | "notify" | "none"
                      ]
                    }
                  </td>
                  <td>
                    {p.completed_at
                      ? new Date(p.completed_at).toLocaleString()
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>采购与生产指令</h2>
        {purchases.length === 0 ? (
          <p>暂无PO，请从已付定金的销售订单开立。</p>
        ) : (
          <ul>
            {purchases.map((p: any) => (
              <li key={p.id}>
                {p.order_number} · {p.status}
                {instructions
                  .filter((i: any) => i.purchase_order_id === p.id)
                  .map((i: any) => (
                    <span key={i.id}>
                      {" "}
                      →{" "}
                      <Link to={`/supply/manufacturing/${i.id}`}>
                        {i.doc_no} 工厂版
                      </Link>
                    </span>
                  ))}
              </li>
            ))}
          </ul>
        )}
        {user.role === "admin" && (
          <ManufacturingForm
            workOrderId={id}
            purchases={purchases.filter(
              (p: any) =>
                !instructions.some((i: any) => i.purchase_order_id === p.id),
            )}
            done={refresh}
          />
        )}
      </section>
      <section className="card">
        <h2>物流回传件（8类）</h2>
        <p>
          仅登记实际收到的文件；核对一致不等于已完成整条物流链。上传文件请到关联
          <Link to={`/quotations/${w.project_id}`}>报价项目附件</Link>。
        </p>
        {user.role === "admin" && (
          <LogisticsForm
            id={id}
            files={files}
            types={docTypes}
            done={refresh}
          />
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>来源</th>
                <th>外部单号</th>
                <th>回传时间</th>
                <th>核对</th>
              </tr>
            </thead>
            <tbody>
              {logistics.map((l: any) => (
                <tr key={l.id}>
                  <td>{l.name_cn}</td>
                  <td>{l.source_name}</td>
                  <td>{l.external_no || "—"}</td>
                  <td>{new Date(l.received_on).toLocaleString()}</td>
                  <td>
                    {l.check_result}
                    {user.role === "admin" && (
                      <>
                        <button
                          disabled={m.busy}
                          onClick={() =>
                            void m.run(
                              `/supply/chain/${id}/logistics/${l.id}/check`,
                              "POST",
                              { result: "matched" },
                              refresh,
                            )
                          }
                        >
                          核对一致
                        </button>
                        <button
                          disabled={m.busy}
                          onClick={() =>
                            void m.run(
                              `/supply/chain/${id}/logistics/${l.id}/check`,
                              "POST",
                              { result: "mismatch" },
                              refresh,
                            )
                          }
                        >
                          存在差异
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>客户通知草稿</h2>
        <p>系统不自动发送客户消息。</p>
        {notices.length ? (
          notices.map((n: any) => (
            <p key={n.id}>
              {n.content}（{n.status}）
            </p>
          ))
        ) : (
          <p>尚无已满足证据条件的通知草稿。</p>
        )}
      </section>
      <section className="card">
        <h2>履约审计</h2>
        {events.map((e: any) => (
          <p key={e.id}>
            {new Date(e.at).toLocaleString()} · {e.actor} · {e.from_stage} →{" "}
            {e.to_stage}
          </p>
        ))}
      </section>
    </>
  );
}
function ProductionStart({
  order,
  files,
  done,
}: {
  order: any;
  files: File[];
  done: () => void;
}) {
  const m = useMutation(),
    [fileId, setFile] = useState(""),
    [note, setNote] = useState("");
  const material = order.current_stage === "po_issued";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.run(
          material
            ? `/supply/chain/${order.id}/advance`
            : `/supply/orders/${order.sales_order_id}/evidence`,
          "POST",
          material
            ? {
                stage: "material_ready",
                fileId,
                inspectionResult: "passed",
                note,
              }
            : { kind: "instruction", note },
          done,
        );
      }}
    >
      <h3>{material ? "核实原材料备齐 / IQC" : "确认开始生产"}</h3>
      <ErrorBox message={m.error} />
      {material && (
        <Field label="IQC检验合格凭证">
          <select
            required
            value={fileId}
            onChange={(e) => setFile(e.target.value)}
          >
            <option value="">请选择真实检验文件</option>
            {files.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={material ? "核对结论" : "投产确认说明"}>
        <textarea
          required
          minLength={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <p>
        {material
          ? "确认代表你已核对原材料及检验结果，不代表后续完工或出货检验通过。"
          : "必须先为全部有效PO签发MO，并完成定金、量尺和最终尺寸确认。"}
      </p>
      <button disabled={m.busy} className="primary">
        {material ? "确认IQC通过、材料备齐" : "核实全部门禁并投产"}
      </button>
    </form>
  );
}
function ManufacturingForm({
  workOrderId,
  purchases,
  done,
}: {
  workOrderId: string;
  purchases: any[];
  done: () => void;
}) {
  const m = useMutation(),
    [po, setPo] = useState(""),
    [fields, setFields] = useState<Record<string, string>>({
      profile: "",
      glass: "",
      hardware: "",
      finish: "",
      sampleReference: "",
      packing: "",
      requiredDate: "",
    });
  if (!purchases.length) return null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.run(
          `/supply/chain/${workOrderId}/manufacturing`,
          "POST",
          { purchaseOrderId: po, technical: fields },
          done,
        );
      }}
    >
      <h3>签发生产指令 MO</h3>
      <p>
        须已上传量尺并确认最终尺寸。仅填写技术信息，不得夹带客户名称、联系方式、地址、目的港或成交价。
      </p>
      <ErrorBox message={m.error} />
      <Field label="关联PO">
        <select required value={po} onChange={(e) => setPo(e.target.value)}>
          <option value="">请选择</option>
          {purchases.map((p) => (
            <option key={p.id} value={p.id}>
              {p.order_number}
            </option>
          ))}
        </select>
      </Field>
      {Object.entries(labels).map(([key, label]) => (
        <Field key={key} label={label}>
          <input
            type={key === "requiredDate" ? "date" : "text"}
            required
            value={fields[key]}
            onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
          />
        </Field>
      ))}
      <button className="primary" disabled={m.busy}>
        核实并签发MO
      </button>
    </form>
  );
}
function LogisticsForm({
  id,
  files,
  types,
  done,
}: {
  id: string;
  files: File[];
  types: any[];
  done: () => void;
}) {
  const m = useMutation(),
    [form, setForm] = useState({
      docType: "",
      fileId: "",
      sourceName: "",
      externalNo: "",
      receivedOn: "",
    });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.run(
          `/supply/chain/${id}/logistics`,
          "POST",
          { ...form, receivedOn: new Date(form.receivedOn).toISOString() },
          done,
        );
      }}
    >
      <ErrorBox message={m.error} />
      <Field label="单据类型">
        <select
          required
          value={form.docType}
          onChange={(e) => setForm({ ...form, docType: e.target.value })}
        >
          <option value="">请选择</option>
          {types.map((t) => (
            <option key={t.code} value={t.code}>
              {t.name_cn}
            </option>
          ))}
        </select>
      </Field>
      <Field label="已上传凭证">
        <select
          required
          value={form.fileId}
          onChange={(e) => setForm({ ...form, fileId: e.target.value })}
        >
          <option value="">请选择</option>
          {files.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>
      {[
        ["sourceName", "回传提供方"],
        ["externalNo", "外部单号"],
        ["receivedOn", "实际回传时间"],
      ].map(([key, label]) => (
        <Field key={key} label={label}>
          <input
            required={key !== "externalNo"}
            type={key === "receivedOn" ? "datetime-local" : "text"}
            value={form[key as keyof typeof form]}
            onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          />
        </Field>
      ))}
      <button disabled={m.busy || !files.length}>保存回传件（待核对）</button>
    </form>
  );
}
export function ManufacturingView() {
  const { id } = useParams(),
    r = useResource<any>(`/supply/manufacturing/${id}`);
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  const d = r.data;
  return (
    <section className="card">
      <h2>生产指令单 / Manufacturing Order</h2>
      <p>
        {d.docNo}　客户编号 / Customer ID：{d.customerCode}
      </p>
      <p>
        WO：{d.woNo}　PO：{d.poNo}
      </p>
      <p>
        <a href={`/api/supply/manufacturing/${id}/export/pdf`}>下载工厂版PDF</a>{" "}
        ·{" "}
        <a href={`/api/supply/manufacturing/${id}/export/xlsx`}>
          下载原模板Excel
        </a>
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>产品行</th>
              <th>已确认尺寸 mm</th>
              <th>数量</th>
            </tr>
          </thead>
          <tbody>
            {d.technical.items.map((i: any, index: number) => (
              <tr key={index}>
                <td>{i.line}</td>
                <td>
                  {i.widthMm} × {i.heightMm}
                </td>
                <td>{i.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <table>
        <tbody>
          {Object.entries(d.technical)
            .filter(([k]) => k !== "items")
            .map(([k, v]) => (
              <tr key={k}>
                <th>{labels[k] || k}</th>
                <td>{String(v)}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <h3>供应商保质期（交付之日起）</h3>
      {d.warranty.map((w: any) => (
        <p key={w.part}>
          {w.part}：{w.months ? `${w.months}个月` : `${w.days}日内`}
        </p>
      ))}
      <p>
        客户仅以13位客户编号标识 / Customer is identified by the 13-digit
        Customer ID only.
      </p>
      <p>本版本仅含工厂授权字段，不可把内部工单替代本单外发。</p>
    </section>
  );
}
