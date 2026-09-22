import { useState } from "react";
import type { User } from "../../shared/contracts.ts";
import { stageNames, supplyLabels } from "../../shared/supply.ts";
import { useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { ErrorBox, Field, Loading, Panel } from "./ui.tsx";

type Item = {
  id: string;
  quantity: number;
  line_key: string;
  configuration_snapshot: Record<string, unknown>;
};
type Update = {
  id: string;
  stage: string;
  quantity: number;
  note: string;
  author: string;
  created_by: string;
  planned_at: string | null;
  actual_at: string;
  review_status: string;
  review_note: string;
  version: number;
};
type Issue = {
  id: string;
  severity: string;
  status: string;
  description: string;
  resolution: string;
  version: number;
};
type Detail = {
  order: {
    id: string;
    order_number: string;
    factory_name: string;
    status: string;
    version: number;
    coordinator_id: string | null;
    factory_confirmed_at: string | null;
    factory_confirmed_price?: string;
    promised_date: string | null;
  };
  items: Item[];
  updates: Update[];
  issues: Issue[];
  inspections: {
    id: string;
    status: string;
    note: string;
    inspector: string;
    inspected_at: string;
  }[];
};
type Package = {
  id: string;
  label: string;
  cbm: string;
  gross_kg: string;
  shipment_id: string | null;
  items: { itemId: string; quantity: number }[];
};
type Rework = {
  id: string;
  status: string;
  description: string;
  factory_note: string;
  review_note: string;
  version: number;
};
type Shipment = {
  id: string;
  shipment_number: string;
  status: string;
  carrier: string;
  tracking_number: string;
  package_ids: string[];
  version: number;
  receipt_evidence: string;
};
type Fulfillment = {
  media: {
    id: string;
    production_update_id: string;
    name: string;
    kind: string;
  }[];
  reworks: Rework[];
  packages: Package[];
  shipments: Shipment[];
  progress: {
    approvedStages: string[];
    pending: number;
    overdue: boolean;
    daysOverdue: number;
    openReworks: number;
  };
  estimate: { cbm: number; grossKg: number };
};
const label = (v: string) => supplyLabels[v] || v;
const time = (v: string | null) =>
  v ? new Date(v).toLocaleString("zh-CN") : "未填写";

function useAction() {
  const m = useMutation(),
    { refresh, notify } = useSession();
  return {
    ...m,
    submit: (url: string, body: unknown, message: string) =>
      m.run(url, "POST", body, () => {
        refresh();
        notify(message);
      }),
  };
}
export function Purchase({ id }: { id: string }) {
  const { user, revision } = useSession(),
    d = useResource<Detail>(`/supply/purchase-orders/${id}`, revision),
    f = useResource<Fulfillment>(
      `/supply/purchase-orders/${id}/fulfillment`,
      revision,
    );
  if (d.loading || f.loading) return <Loading />;
  if (!d.data || !f.data) return <ErrorBox message={d.error || f.error} />;
  const x = d.data,
    flow = f.data,
    base = `/supply/purchase-orders/${id}`,
    canReview = ["admin", "coordinator", "technical", "logistics"].includes(
      user.role,
    ),
    canEdit = user.role !== "sales",
    active =
      !!x.order.factory_confirmed_at &&
      !["cancelled", "shipped"].includes(x.order.status);
  return (
    <div className="purchase-workspace">
      <Panel title={`${x.order.order_number} · ${x.order.factory_name}`}>
        <p>
          状态：{label(x.order.status)} · 交货日期：
          {x.order.promised_date || "待工厂确认"}
          {x.order.factory_confirmed_price !== undefined &&
            ` · 确认供货总价：CNY ${x.order.factory_confirmed_price}`}
        </p>
        <div className="supply-grid">
          <div className="supply-card">
            <b>{flow.progress.approvedStages.length} 个节点已审核</b>
            <span>{flow.progress.pending} 条反馈待审核</span>
          </div>
          <div className="supply-card">
            <b>
              {flow.progress.overdue
                ? `交期已逾期 ${flow.progress.daysOverdue} 天`
                : "交期尚未逾期"}
            </b>
            <span>{flow.progress.openReworks} 项返工待完成</span>
          </div>
        </div>
        {flow.progress.overdue && (
          <p className="error" role="alert">
            交货日期已过，订单尚未全部发出，请跟单核实交期。
          </p>
        )}
        <h3>本采购订单产品</h3>
        {x.items.map((i) => (
          <div className="supply-event" key={i.id}>
            <b>{String(i.configuration_snapshot.sku || i.line_key)}</b> ·{" "}
            {i.quantity} 件
            <p>
              {String(i.configuration_snapshot.width)} ×{" "}
              {String(i.configuration_snapshot.height)}{" "}
              {String(i.configuration_snapshot.unit || "mm")}
            </p>
            <p>
              {Object.entries(
                (i.configuration_snapshot.specs || {}) as Record<
                  string,
                  string
                >,
              )
                .map(([k, v]) => `${k}: ${v}`)
                .join(" · ")}
            </p>
          </div>
        ))}
        {user.role === "admin" && <Assignment base={base} order={x.order} />}
        {user.role === "factory" && !x.order.factory_confirmed_at && (
          <Acceptance base={base} version={x.order.version} />
        )}
      </Panel>
      <Panel title="生产反馈与审核">
        <p className="muted">
          每条反馈填写本批完成数量。审核通过后计入实际进度，同一节点累计数量不能超过订单数量。
        </p>
        {canEdit && active && <ProgressForm base={base} />}
        {!x.updates.length && <p>尚无生产反馈。</p>}
        {x.updates.map((u) => (
          <article className="supply-event" key={u.id}>
            <h3>
              {stageNames[u.stage]} · {u.quantity} 件 · {label(u.review_status)}
            </h3>
            <p>
              提交：{u.author} · 计划：{time(u.planned_at)} · 实际：
              {time(u.actual_at)}
            </p>
            <p>{u.note}</p>
            {u.review_note && <p>审核意见：{u.review_note}</p>}
            <ul>
              {flow.media
                .filter((file) => file.production_update_id === u.id)
                .map((file) => (
                  <li key={file.id}>
                    <a href={`/api/supply/media/${file.id}`}>
                      {file.name} · 下载
                      {file.kind === "video"
                        ? "视频"
                        : file.kind === "photo"
                          ? "照片"
                          : "资料"}
                    </a>
                  </li>
                ))}
            </ul>
            {canEdit &&
              u.review_status === "pending" &&
              (user.role !== "factory" || u.created_by === user.id) && (
                <EvidenceUpload base={base} updateId={u.id} />
              )}
            {canReview &&
              active &&
              u.review_status === "pending" &&
              u.created_by !== user.id && (
                <ReviewForm
                  url={`${base}/updates/${u.id}/review`}
                  version={u.version}
                />
              )}
          </article>
        ))}
      </Panel>
      <Panel title="异常、质检与返工">
        {canEdit && active && <IssueForm base={base} />}
        {x.issues.map((i) => (
          <article className="supply-event" key={i.id}>
            <b>
              {i.severity} · {label(i.status)}
            </b>
            <p>{i.description}</p>
            <p>{i.resolution}</p>
            {canReview && ["open", "mitigating"].includes(i.status) && (
              <TextAction
                label="解决说明"
                button="确认解决异常"
                url={`${base}/issues/${i.id}/resolve`}
                version={i.version}
                field="resolution"
              />
            )}
          </article>
        ))}
        {canReview && active && <QualityForm base={base} />}
        {x.inspections.map((i) => (
          <div className="supply-event" key={i.id}>
            <b>{label(i.status)}</b>
            <p>
              {i.note} · {i.inspector} · {time(i.inspected_at)}
            </p>
          </div>
        ))}
        {flow.reworks.map((r) => (
          <article className="supply-event" key={r.id}>
            <h3>返工任务 · {label(r.status)}</h3>
            <p>{r.description}</p>
            <p>工厂说明：{r.factory_note || "未提交"}</p>
            <p>复核意见：{r.review_note || "未审核"}</p>
            {user.role === "factory" && active && r.status === "open" && (
              <TextAction
                label="返工完成说明"
                button="提交返工结果"
                url={`${base}/reworks/${r.id}/submit`}
                version={r.version}
              />
            )}{" "}
            {canReview && active && r.status === "submitted" && (
              <ReviewForm
                url={`${base}/reworks/${r.id}/review`}
                version={r.version}
              />
            )}
          </article>
        ))}
      </Panel>
      <Panel title="最终包装与分批发货">
        <p>
          报价预估：{flow.estimate.cbm.toFixed(3)} CBM /{" "}
          {flow.estimate.grossKg.toFixed(2)} kg；实际已登记：
          {flow.packages.reduce((s, p) => s + Number(p.cbm), 0).toFixed(3)} CBM
          /{" "}
          {flow.packages.reduce((s, p) => s + Number(p.gross_kg), 0).toFixed(2)}{" "}
          kg。
        </p>
        {canEdit && active && (
          <PackageForm base={base} items={x.items} packages={flow.packages} />
        )}
        {flow.packages.map((p) => (
          <div className="supply-event" key={p.id}>
            <b>{p.label}</b> · {Number(p.cbm).toFixed(3)} CBM · 毛重{" "}
            {p.gross_kg} kg · {p.shipment_id ? "已分配批次" : "待安排发货"}
          </div>
        ))}
        {canEdit && active && (
          <ShipmentForm
            base={base}
            packages={flow.packages.filter((p) => !p.shipment_id)}
          />
        )}
        {flow.shipments.map((s) => (
          <ShipmentCard
            key={s.id}
            shipment={s}
            base={base}
            canReview={canReview}
          />
        ))}
      </Panel>
    </div>
  );
}
function Assignment({ base, order }: { base: string; order: Detail["order"] }) {
  const users = useResource<User[]>("/team"),
    m = useAction(),
    [value, set] = useState(order.coordinator_id || "");
  return (
    <div className="supply-actions">
      <Field label="负责跟单">
        <select value={value} onChange={(e) => set(e.target.value)}>
          <option value="">请选择</option>
          {users.data
            ?.filter(
              (u) =>
                u.active &&
                ["coordinator", "technical", "logistics"].includes(u.role),
            )
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} · {u.role}
              </option>
            ))}
        </select>
      </Field>
      <button
        disabled={!value || m.busy}
        onClick={() =>
          void m.submit(
            `${base}/assign`,
            { userId: value, version: order.version },
            "跟单已分配",
          )
        }
      >
        分配跟单
      </button>
      <ErrorBox message={users.error || m.error} />
    </div>
  );
}
function Acceptance({ base, version }: { base: string; version: number }) {
  const m = useAction(),
    [price, setPrice] = useState(""),
    [date, setDate] = useState(""),
    [note, setNote] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.submit(
          `${base}/confirm`,
          { price: Number(price), promisedDate: date, note, version },
          "已确认接单、价格和交期",
        );
      }}
    >
      <div className="form-grid">
        <Field label="确认供货总价">
          <input
            type="number"
            min="0"
            step="0.01"
            required
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
        <Field label="承诺交货日期">
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="接单说明">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <button className="primary" disabled={m.busy}>
        确认接单
      </button>
      <ErrorBox message={m.error} />
    </form>
  );
}
function ProgressForm({ base }: { base: string }) {
  const m = useAction(),
    [stage, setStage] = useState("materials"),
    [quantity, setQty] = useState(""),
    [planned, setPlanned] = useState(""),
    [actual, setActual] = useState(""),
    [note, setNote] = useState("");
  return (
    <details open>
      <summary>提交生产反馈</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void m.submit(
            `${base}/updates`,
            {
              stage,
              quantity: Number(quantity),
              note,
              plannedAt: planned ? new Date(planned).toISOString() : null,
              actualAt: new Date(actual).toISOString(),
            },
            "反馈已提交，请在该反馈下上传资料并等待公司审核",
          );
        }}
      >
        <div className="form-grid">
          <Field label="生产节点">
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              {Object.entries(stageNames)
                .filter(([k]) => k !== "shipped")
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="本批完成数量">
            <input
              required
              type="number"
              min="0"
              value={quantity}
              onChange={(e) => setQty(e.target.value)}
            />
          </Field>
          <Field label="计划时间">
            <input
              type="datetime-local"
              value={planned}
              onChange={(e) => setPlanned(e.target.value)}
            />
          </Field>
          <Field label="实际完成时间">
            <input
              type="datetime-local"
              required
              value={actual}
              onChange={(e) => setActual(e.target.value)}
            />
          </Field>
          <Field label="节点说明">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <button className="primary" disabled={m.busy}>
          提交反馈
        </button>
        <ErrorBox message={m.error} />
      </form>
    </details>
  );
}
function EvidenceUpload({
  base,
  updateId,
}: {
  base: string;
  updateId: string;
}) {
  const m = useAction();
  async function upload(file: File) {
    if (file.size > 8e6) {
      m.setError("单个文件不能超过8MB");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      await m.submit(
        `${base}/media`,
        {
          updateId,
          name: file.name,
          mime: file.type,
          kind: file.type.startsWith("image/")
            ? "photo"
            : file.type.startsWith("video/")
              ? "video"
              : "document",
          data: btoa(binary),
        },
        "资料已保存",
      );
    } catch {
      m.setError("无法读取文件，请重试");
    }
  }
  return (
    <>
      <Field label="上传照片、视频或报告（8MB以内）">
        <input
          type="file"
          disabled={m.busy}
          accept="image/jpeg,image/png,image/webp,video/mp4,application/pdf"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = "";
          }}
        />
      </Field>
      <ErrorBox message={m.error} />
    </>
  );
}
function ReviewForm({ url, version }: { url: string; version: number }) {
  const m = useAction(),
    [note, set] = useState("");
  return (
    <div>
      <Field label="审核意见">
        <input
          minLength={2}
          value={note}
          onChange={(e) => set(e.target.value)}
        />
      </Field>
      <div className="actions">
        <button
          disabled={m.busy || note.trim().length < 2}
          onClick={() =>
            void m.submit(
              url,
              { version, status: "approved", note },
              "审核通过",
            )
          }
        >
          审核通过
        </button>
        <button
          disabled={m.busy || note.trim().length < 2}
          onClick={() =>
            void m.submit(url, { version, status: "rejected", note }, "已退回")
          }
        >
          退回修改
        </button>
      </div>
      <ErrorBox message={m.error} />
    </div>
  );
}
function TextAction({
  url,
  version,
  label: fieldLabel,
  button,
  field = "note",
}: {
  url: string;
  version: number;
  label: string;
  button: string;
  field?: string;
}) {
  const m = useAction(),
    [value, set] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.submit(url, { version, [field]: value }, "已保存");
      }}
    >
      <Field label={fieldLabel}>
        <textarea
          required
          minLength={5}
          value={value}
          onChange={(e) => set(e.target.value)}
        />
      </Field>
      <button disabled={m.busy}>{button}</button>
      <ErrorBox message={m.error} />
    </form>
  );
}
function IssueForm({ base }: { base: string }) {
  const m = useAction(),
    [severity, setSeverity] = useState("medium"),
    [description, set] = useState("");
  return (
    <details>
      <summary>提交生产异常</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void m.submit(
            `${base}/issues`,
            { severity, description },
            "异常已提交",
          );
        }}
      >
        <Field label="异常等级">
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
          >
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高（阻止发货）</option>
            <option value="critical">严重（阻止发货）</option>
          </select>
        </Field>
        <Field label="异常说明">
          <textarea
            required
            minLength={5}
            value={description}
            onChange={(e) => set(e.target.value)}
          />
        </Field>
        <button disabled={m.busy}>提交异常</button>
        <ErrorBox message={m.error} />
      </form>
    </details>
  );
}
function QualityForm({ base }: { base: string }) {
  const m = useAction(),
    [status, set] = useState("passed"),
    [note, setNote] = useState(""),
    [checks, setChecks] = useState([
      { name: "规格尺寸与批准图纸一致", passed: false },
      { name: "外观和表面质量合格", passed: false },
      { name: "五金、玻璃与功能测试合格", passed: false },
    ]);
  return (
    <details>
      <summary>公司质检 / 返工后复检</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void m.submit(
            `${base}/quality`,
            { status, note, checklist: checks },
            "质检已保存；不通过会自动创建返工任务",
          );
        }}
      >
        <div className="supply-lines">
          {checks.map((c, i) => (
            <label key={c.name}>
              <input
                type="checkbox"
                checked={c.passed}
                onChange={(e) =>
                  setChecks((v) =>
                    v.map((x, n) =>
                      n === i ? { ...x, passed: e.target.checked } : x,
                    ),
                  )
                }
              />
              {c.name}
            </label>
          ))}
        </div>
        <Field label="质检结果">
          <select value={status} onChange={(e) => set(e.target.value)}>
            <option value="passed">通过</option>
            <option value="failed">不通过并创建返工</option>
            <option value="conditional">有条件通过（暂不能发货）</option>
          </select>
        </Field>
        <Field label="质检说明">
          <textarea
            required
            minLength={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <button disabled={m.busy}>保存质检</button>
        <ErrorBox message={m.error} />
      </form>
    </details>
  );
}
function PackageForm({
  base,
  items,
  packages,
}: {
  base: string;
  items: Item[];
  packages: Package[];
}) {
  const m = useAction(),
    [name, setName] = useState(""),
    [sizes, setSizes] = useState({
      lengthMm: "",
      widthMm: "",
      heightMm: "",
      netKg: "",
      grossKg: "",
    }),
    [quantities, setQuantities] = useState<Record<string, string>>({});
  return (
    <details>
      <summary>录入最终包装</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void m.submit(
            `${base}/packages`,
            {
              label: name,
              ...Object.fromEntries(
                Object.entries(sizes).map(([k, v]) => [k, Number(v)]),
              ),
              items: items
                .filter((i) => Number(quantities[i.id]) > 0)
                .map((i) => ({
                  itemId: i.id,
                  quantity: Number(quantities[i.id]),
                })),
            },
            "包装已保存",
          );
        }}
      >
        <div className="form-grid">
          <Field label="包装箱号">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {(
            [
              ["lengthMm", "包装长 mm"],
              ["widthMm", "包装宽 mm"],
              ["heightMm", "包装高 mm"],
              ["netKg", "净重 kg"],
              ["grossKg", "毛重 kg"],
            ] as const
          ).map(([k, v]) => (
            <Field key={k} label={v}>
              <input
                required
                type="number"
                min={k === "netKg" ? 0 : 0.001}
                step="0.001"
                value={sizes[k]}
                onChange={(e) =>
                  setSizes((s) => ({ ...s, [k]: e.target.value }))
                }
              />
            </Field>
          ))}
        </div>
        <h4>本箱产品数量</h4>
        {items.map((i) => {
          const packed = packages.reduce(
            (s, p) =>
              s +
              p.items
                .filter((x) => x.itemId === i.id)
                .reduce((a, x) => a + x.quantity, 0),
            0,
          );
          return (
            <Field
              key={i.id}
              label={`${String(i.configuration_snapshot.sku || i.line_key)}（剩余 ${i.quantity - packed} 件）`}
            >
              <input
                type="number"
                min="0"
                max={i.quantity - packed}
                value={quantities[i.id] || ""}
                onChange={(e) =>
                  setQuantities((v) => ({ ...v, [i.id]: e.target.value }))
                }
              />
            </Field>
          );
        })}
        <button disabled={m.busy}>保存包装</button>
        <ErrorBox message={m.error} />
      </form>
    </details>
  );
}
function ShipmentForm({
  base,
  packages,
}: {
  base: string;
  packages: Package[];
}) {
  const m = useAction(),
    [selected, set] = useState<string[]>([]),
    [carrier, setCarrier] = useState(""),
    [tracking, setTracking] = useState("");
  return (
    <details>
      <summary>安排分批发货</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void m.submit(
            `${base}/shipments`,
            { packageIds: selected, carrier, trackingNumber: tracking },
            "批次已建立，等待公司核验质检和包装后放行",
          );
        }}
      >
        <div className="supply-lines">
          {packages.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={selected.includes(p.id)}
                onChange={(e) =>
                  set((v) =>
                    e.target.checked
                      ? [...v, p.id]
                      : v.filter((id) => id !== p.id),
                  )
                }
              />
              {p.label}
            </label>
          ))}
        </div>
        {!packages.length && <p>暂无未安排的包装。</p>}
        <Field label="承运商">
          <input
            required
            value={carrier}
            onChange={(e) => setCarrier(e.target.value)}
          />
        </Field>
        <Field label="运单号">
          <input
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
          />
        </Field>
        <button disabled={m.busy || !selected.length}>创建发货批次</button>
        <ErrorBox message={m.error} />
      </form>
    </details>
  );
}
function ShipmentCard({
  base,
  shipment: s,
  canReview,
}: {
  base: string;
  shipment: Shipment;
  canReview: boolean;
}) {
  const m = useAction();
  return (
    <article className="supply-event">
      <h3>
        {s.shipment_number} · {label(s.status)}
      </h3>
      <p>
        {s.carrier} · {s.tracking_number || "未填写运单号"} ·{" "}
        {s.package_ids.length} 个包装
      </p>
      {s.receipt_evidence && <p>签收依据：{s.receipt_evidence}</p>}
      {canReview && s.status === "draft" && (
        <button
          disabled={m.busy}
          onClick={() =>
            void m.submit(
              `${base}/shipments/${s.id}/dispatch`,
              { version: s.version },
              "发货已放行",
            )
          }
        >
          核验并确认发货
        </button>
      )}
      {canReview && s.status === "dispatched" && (
        <TextAction
          label="签收凭据说明"
          button="记录签收"
          url={`${base}/shipments/${s.id}/receive`}
          version={s.version}
          field="evidence"
        />
      )}
      <ErrorBox message={m.error} />
    </article>
  );
}
