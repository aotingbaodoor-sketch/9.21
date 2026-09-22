import { useState } from "react";
import { useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { ErrorBox, Field, Loading, Panel } from "./ui.tsx";
import { Purchase } from "./PurchaseWorkspace.tsx";
export { Purchase } from "./PurchaseWorkspace.tsx";

type Order = {
  id: string;
  order_number: string;
  status: string;
  company: string;
  items: number;
  purchase_orders: number;
};
type Factory = { id: string; name: string; active: boolean; accounts?: number };
type Item = {
  id: string;
  line_key: string;
  quantity: number;
  configuration_snapshot: Record<string, unknown>;
};
type Detail = {
  order: Order;
  items: Item[];
  purchases: {
    id: string;
    order_number: string;
    status: string;
    factory_name: string;
    promised_date: string | null;
  }[];
};
const SupplyStatus = ({ value }: { value: string }) => (
  <span className="supply-status">{value}</span>
);

export function SupplyChain() {
  const { user, revision } = useSession(),
    orders = useResource<Order[]>("/supply/orders", revision),
    [id, setId] = useState("");
  if (orders.loading) return <Loading />;
  return (
    <>
      <Panel title="销售订单与供应链">
        <p className="quote-help">
          销售订单只能由客户确认后的报价生成，确保产品、价格和图纸可追溯。管理员先建立合作工厂，再从订单中拆分产品。
        </p>
        <ErrorBox message={orders.error} />
        <div className="supply-grid">
          {orders.data?.map((o) => (
            <button
              className="supply-card"
              key={o.id}
              onClick={() => setId(o.id)}
            >
              <b>{o.order_number}</b>
              <span>{o.company}</span>
              <SupplyStatus value={o.status} />
              <small>
                {o.items} 个产品 · {o.purchase_orders} 张工厂单
              </small>
            </button>
          ))}
        </div>
        {!orders.data?.length && (
          <div className="supply-empty">
            <b>还没有销售订单</b>
            <p>
              请先在“报价管理”创建并确认一份报价；客户确认后会自动生成订单，并在这里显示。
            </p>
          </div>
        )}
      </Panel>
      {user.role === "admin" && <FactoryManager />}
      {id && <OrderView key={id} id={id} />}
    </>
  );
}
export function FactoryManager() {
  const { revision, refresh, notify } = useSession(),
    factories = useResource<Factory[]>("/supply/factories", revision),
    m = useMutation(),
    [name, setName] = useState(""),
    [person, setPerson] = useState(""),
    [phone, setPhone] = useState(""),
    [email, setEmail] = useState(""),
    [selected, setSelected] = useState(""),
    [accountName, setAccountName] = useState(""),
    [accountEmail, setAccountEmail] = useState(""),
    [password, setPassword] = useState("");
  const save = () =>
    void m.run(
      "/supply/factories",
      "POST",
      { name, contact: { person, phone, email } },
      () => {
        setName("");
        setPerson("");
        setPhone("");
        setEmail("");
        refresh();
        notify("合作工厂已建立，可用于订单拆分");
      },
    );
  const invite = () =>
    void m.run(
      `/supply/factories/${selected}/invite`,
      "POST",
      { name: accountName, email: accountEmail, password },
      () => {
        setAccountName("");
        setAccountEmail("");
        setPassword("");
        refresh();
        notify("工厂独立账号已创建并绑定");
      },
    );
  return (
    <Panel title="合作工厂与账号管理">
      <p className="quote-help">
        先建立工厂，再为该工厂创建独立登录账号。工厂账号只能访问本工厂产品和采购订单。
      </p>
      <h3>新增合作工厂</h3>
      <div className="supply-actions">
        <Field label="工厂名称">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：奥汀堡门窗工厂"
          />
        </Field>
        <Field label="联系人">
          <input value={person} onChange={(e) => setPerson(e.target.value)} />
        </Field>
        <Field label="电话">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="邮箱">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <button
          className="primary"
          disabled={m.busy || name.trim().length < 2}
          onClick={save}
        >
          新增合作工厂
        </button>
      </div>
      <h3>邀请工厂账号</h3>
      <div className="supply-actions">
        <Field label="绑定工厂">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">请选择</option>
            {factories.data
              ?.filter((f) => f.active)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="账号姓名">
          <input
            value={accountName}
            onChange={(e) => setAccountName(e.target.value)}
          />
        </Field>
        <Field label="登录邮箱">
          <input
            type="email"
            value={accountEmail}
            onChange={(e) => setAccountEmail(e.target.value)}
          />
        </Field>
        <Field label="初始密码（至少12位）">
          <input
            type="password"
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <button
          className="primary"
          disabled={
            m.busy ||
            !selected ||
            !accountName.trim() ||
            !accountEmail.trim() ||
            password.length < 12
          }
          onClick={invite}
        >
          创建并绑定账号
        </button>
      </div>
      <ErrorBox message={m.error} />
      <div className="supply-grid">
        {factories.data?.map((f) => (
          <div className="supply-card" key={f.id}>
            <b>{f.name}</b>
            <SupplyStatus value={f.active ? "启用" : "停用"} />
            <small>{f.accounts || 0} 个已批准账号</small>
          </div>
        ))}
      </div>
      {!factories.data?.length && <p className="muted">尚未建立合作工厂。</p>}
    </Panel>
  );
}
function OrderView({ id }: { id: string }) {
  const { user, revision, refresh, notify } = useSession(),
    d = useResource<Detail>(`/supply/orders/${id}`, revision),
    factories = useResource<Factory[]>("/supply/factories", revision),
    m = useMutation(),
    [factory, setFactory] = useState(""),
    [items, setItems] = useState<string[]>([]),
    [date, setDate] = useState(""),
    [po, setPo] = useState("");
  if (d.loading) return <Loading />;
  if (!d.data) return <ErrorBox message={d.error} />;
  const x = d.data;
  return (
    <>
      <Panel title={`${x.order.order_number} · ${x.order.company}`}>
        <div className="supply-lines">
          {x.items.map((i) => (
            <label key={i.id}>
              <input
                type="checkbox"
                disabled={user.role !== "admin"}
                checked={items.includes(i.id)}
                onChange={(e) =>
                  setItems(
                    e.target.checked
                      ? [...items, i.id]
                      : items.filter((v) => v !== i.id),
                  )
                }
              />
              <b>{i.line_key}</b> · {i.quantity} 件 ·{" "}
              {String(i.configuration_snapshot.sku || "产品配置")}
            </label>
          ))}
        </div>
        {user.role === "admin" && (
          <div className="supply-split">
            <Field label="合作工厂">
              <select
                value={factory}
                onChange={(e) => setFactory(e.target.value)}
              >
                <option value="">请选择</option>
                {factories.data
                  ?.filter((f) => f.active)
                  .map((f) => (
                    <option value={f.id} key={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="承诺交期">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <button
              className="primary"
              disabled={!factory || !items.length || m.busy}
              onClick={() =>
                void m.run(
                  `/supply/orders/${id}/purchase-orders`,
                  "POST",
                  {
                    factoryId: factory,
                    itemIds: items,
                    promisedDate: date || null,
                  },
                  () => {
                    setItems([]);
                    refresh();
                    notify("已创建工厂采购订单");
                  },
                )
              }
            >
              拆分工厂订单
            </button>
          </div>
        )}
        <ErrorBox message={m.error} />
      </Panel>
      <Panel title="工厂订单">
        <div className="supply-grid">
          {x.purchases.map((p) => (
            <button
              className="supply-card"
              key={p.id}
              onClick={() => setPo(p.id)}
            >
              <b>{p.order_number}</b>
              <span>{p.factory_name}</span>
              <SupplyStatus value={p.status} />
              <small>交期：{p.promised_date || "待确认"}</small>
            </button>
          ))}
        </div>
      </Panel>
      {po && <Purchase key={po} id={po} />}
    </>
  );
}
