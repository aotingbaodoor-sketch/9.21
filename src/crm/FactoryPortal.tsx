import { useState } from "react";
import { categories, methods } from "../../shared/quoting.ts";
import { useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { ErrorBox, Field, Loading, Panel } from "./ui.tsx";
import { Purchase } from "./SupplyChain.tsx";

type FactoryProduct = {
  id: string;
  factory_id: string;
  factory_name: string;
  sku: string;
  name_zh: string;
  name_en: string;
  category: string;
  series: string;
  specification: string;
  image_urls: string[];
  supply_price: string;
  currency: string;
  pricing_method: string;
  pricing_rule: Record<string, unknown>;
  lead_days: number;
  status: string;
  review_note: string;
  version: number;
};
type PurchaseOrder = {
  id: string;
  order_number: string;
  status: string;
  promised_date: string | null;
  factory_confirmed_at: string | null;
  factory_confirmed_price: string | null;
  factory_name: string;
  company: string;
};
const labels: Record<string, string> = {
  draft: "草稿",
  submitted: "待公司审核",
  approved: "已发布销售目录",
  rejected: "已驳回",
  disabled: "已停用",
};

export function FactoryProducts() {
  const { user, revision } = useSession(),
    products = useResource<FactoryProduct[]>(
      "/supply/factory-products",
      revision,
    ),
    [show, setShow] = useState(false);
  if (products.loading) return <Loading />;
  return (
    <>
      <Panel title={user.role === "factory" ? "我的供货产品" : "工厂产品审核"}>
        <p className="quote-help">
          供货价仅对工厂与授权公司人员可见。审核通过后，销售只能使用公司发布的销售价格。
        </p>
        {user.role === "factory" && (
          <button className="primary" onClick={() => setShow(!show)}>
            {show ? "收起录入" : "＋ 录入供货产品"}
          </button>
        )}
        <ErrorBox message={products.error} />
        {show && <FactoryProductForm close={() => setShow(false)} />}
        <div className="supply-grid">
          {products.data?.map((p) => (
            <FactoryProductCard key={p.id} product={p} />
          ))}
        </div>
        {!products.data?.length && (
          <div className="supply-empty">暂无供货产品。</div>
        )}
      </Panel>
    </>
  );
}
function FactoryProductForm({ close }: { close: () => void }) {
  const { refresh, notify } = useSession(),
    m = useMutation(),
    [form, setForm] = useState({
      sku: "",
      nameZh: "",
      nameEn: "",
      category: "推拉门",
      series: "",
      specification: "",
      imageUrls: "",
      supplyPrice: 0,
      currency: "CNY",
      pricingMethod: "area_options",
      leadDays: 30,
    });
  const set = (key: string, value: unknown) =>
    setForm((v) => ({ ...v, [key]: value }));
  const save = () =>
    void m.run(
      "/supply/factory-products",
      "POST",
      {
        ...form,
        imageUrls: form.imageUrls
          .split(/\r?\n/)
          .map((v) => v.trim())
          .filter(Boolean),
        pricingRule: {},
      },
      () => {
        refresh();
        notify("产品草稿已保存，请核对后提交公司审核");
        close();
      },
    );
  return (
    <div className="factory-form">
      <div className="form-grid">
        <Field label="产品编号 *">
          <input
            value={form.sku}
            onChange={(e) => set("sku", e.target.value)}
          />
        </Field>
        <Field label="中文名称 *">
          <input
            value={form.nameZh}
            onChange={(e) => set("nameZh", e.target.value)}
          />
        </Field>
        <Field label="英文名称">
          <input
            value={form.nameEn}
            onChange={(e) => set("nameEn", e.target.value)}
          />
        </Field>
        <Field label="产品类别">
          <select
            value={form.category}
            onChange={(e) => set("category", e.target.value)}
          >
            {categories.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label="系列">
          <input
            value={form.series}
            onChange={(e) => set("series", e.target.value)}
          />
        </Field>
        <Field label="供货价（人民币）">
          <input
            type="number"
            min={0}
            step="0.01"
            value={form.supplyPrice}
            onChange={(e) => set("supplyPrice", Number(e.target.value))}
          />
        </Field>
        <Field label="计价方式">
          <select
            value={form.pricingMethod}
            onChange={(e) => set("pricingMethod", e.target.value)}
          >
            {methods.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="常规交期（天）">
          <input
            type="number"
            min={0}
            value={form.leadDays}
            onChange={(e) => set("leadDays", Number(e.target.value))}
          />
        </Field>
        <Field label="规格说明" wide>
          <textarea
            value={form.specification}
            onChange={(e) => set("specification", e.target.value)}
          />
        </Field>
        <Field label="产品图片 HTTPS 地址（每行一个）" wide>
          <textarea
            value={form.imageUrls}
            onChange={(e) => set("imageUrls", e.target.value)}
          />
        </Field>
      </div>
      <ErrorBox message={m.error} />
      <div className="actions">
        <button
          className="primary"
          disabled={m.busy || !form.sku.trim() || !form.nameZh.trim()}
          onClick={save}
        >
          保存草稿
        </button>
        <button onClick={close}>取消</button>
      </div>
    </div>
  );
}
function FactoryProductCard({ product: p }: { product: FactoryProduct }) {
  const { user, refresh, notify } = useSession(),
    m = useMutation(),
    [note, setNote] = useState(""),
    [guide, setGuide] = useState(Number(p.supply_price) * 1.4),
    [minimum, setMinimum] = useState(Number(p.supply_price) * 1.2),
    [retail, setRetail] = useState(Number(p.supply_price) * 1.6);
  const submit = () =>
    void m.run(
      `/supply/factory-products/${p.id}/submit`,
      "POST",
      { version: p.version },
      () => {
        refresh();
        notify("已提交公司审核");
      },
    );
  const review = (status: "approved" | "rejected") =>
    void m.run(
      `/supply/factory-products/${p.id}/review`,
      "POST",
      {
        status,
        note,
        guidePrice: guide,
        minimumPrice: minimum,
        retailPrice: retail,
        active: true,
        version: p.version,
      },
      () => {
        refresh();
        notify(
          status === "approved" ? "已发布到销售产品目录" : "已退回工厂修改",
        );
      },
    );
  return (
    <div className="factory-product">
      <div className="factory-product-head">
        <b>
          {p.sku} · {p.name_zh}
        </b>
        <span className="supply-status">{labels[p.status] || p.status}</span>
      </div>
      <p>
        {p.factory_name} · {p.category} · {p.series || "未填写系列"}
      </p>
      <p>{p.specification || "未填写规格"}</p>
      <dl>
        <dt>工厂供货价</dt>
        <dd>
          {p.currency} {Number(p.supply_price).toFixed(2)}
        </dd>
        <dt>计价方式</dt>
        <dd>{p.pricing_method}</dd>
        <dt>常规交期</dt>
        <dd>{p.lead_days} 天</dd>
      </dl>
      {p.review_note && (
        <p className="quote-issues">审核意见：{p.review_note}</p>
      )}
      {user.role === "factory" && ["draft", "rejected"].includes(p.status) && (
        <button className="primary" disabled={m.busy} onClick={submit}>
          提交公司审核
        </button>
      )}
      {user.role === "admin" && p.status === "submitted" && (
        <div className="factory-review">
          <Field label="销售指导价">
            <input
              type="number"
              value={guide}
              onChange={(e) => setGuide(Number(e.target.value))}
            />
          </Field>
          <Field label="最低销售价">
            <input
              type="number"
              value={minimum}
              onChange={(e) => setMinimum(Number(e.target.value))}
            />
          </Field>
          <Field label="建议零售价">
            <input
              type="number"
              value={retail}
              onChange={(e) => setRetail(Number(e.target.value))}
            />
          </Field>
          <Field label="审核意见">
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="actions">
            <button
              className="primary"
              disabled={m.busy}
              onClick={() => review("approved")}
            >
              审核通过并发布
            </button>
            <button
              disabled={m.busy || !note.trim()}
              onClick={() => review("rejected")}
            >
              退回修改
            </button>
          </div>
        </div>
      )}
      <ErrorBox message={m.error} />
    </div>
  );
}

export function FactoryOrders() {
  const { user, revision } = useSession(),
    orders = useResource<PurchaseOrder[]>("/supply/purchase-orders", revision),
    [selected, setSelected] = useState("");
  if (orders.loading) return <Loading />;
  return (
    <>
      <Panel title={user.role === "factory" ? "工厂采购订单" : "我的跟单任务"}>
        <p className="quote-help">
          {user.role === "factory"
            ? "只显示本工厂采购订单，可确认接单并提交生产反馈。"
            : "只显示已分配给你的采购订单，可审核反馈、质检、返工及分批发货。"}
        </p>
        <ErrorBox message={orders.error} />
        <div className="supply-grid">
          {orders.data?.map((o) => (
            <button
              className="supply-card"
              key={o.id}
              onClick={() => setSelected(o.id)}
            >
              <b>{o.order_number}</b>
              <span>{o.company}</span>
              <span className="supply-status">{o.status}</span>
              <small>
                {o.factory_name} · 交期 {o.promised_date || "待确认"}
              </small>
            </button>
          ))}
        </div>
        {!orders.data?.length && (
          <div className="supply-empty">暂时没有分配给本账号的采购订单。</div>
        )}
      </Panel>
      {selected && <Purchase key={selected} id={selected} />}
    </>
  );
}
