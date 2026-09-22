import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  customerSchema,
  grades,
  methods,
  sources,
  stages,
  userSchema,
} from "../../shared/contracts.ts";
import type { Customer, CustomerInput, User } from "../../shared/contracts.ts";
import { ApiError, useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { ErrorBox, Field, Loading, Modal } from "./ui.tsx";

export function CustomerForm({
  customer,
  close,
}: {
  customer: Customer | null;
  close: () => void;
}) {
  const { user, notify, refresh } = useSession(),
    m = useMutation();
  const team = useResource<User[]>(
    user.role === "admin" ? "/team" : "/auth/owners",
  );
  const [f, setF] = useState<CustomerInput>(() =>
    customer
      ? (Object.fromEntries(
          Object.entries(customer).filter(
            ([key]) => key in customerSchema.shape,
          ),
        ) as CustomerInput)
      : customerSchema.parse({ company: "待填写", ownerId: user.id }),
  );
  const [company, setCompany] = useState(customer?.company || ""),
    [duplicates, setDuplicates] = useState<{ id: string; company: string }[]>(
      [],
    ),
    [allow, setAllow] = useState(false);
  const set = <K extends keyof CustomerInput>(k: K, v: CustomerInput[K]) => {
    setF({ ...f, [k]: v });
    setAllow(false);
  };
  const input = (
    key:
      | "contact"
      | "country"
      | "city"
      | "phone"
      | "whatsapp"
      | "email"
      | "website"
      | "product"
      | "quantity",
    label: string,
    type = "text",
  ) => (
    <Field label={label}>
      <input
        type={type}
        value={f[key]}
        onChange={(e) => set(key, e.target.value)}
      />
    </Field>
  );
  const [tagText, setTagText] = useState(customer?.tags.join(",") || "");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const result = await m.run(
      customer ? `/customers/${customer.id}` : "/customers",
      customer ? "PUT" : "POST",
      {
        ...f,
        tags: [
          ...new Set(
            tagText
              .split(/[,，]/)
              .map((t) => t.trim())
              .filter(Boolean),
          ),
        ],
        company,
        ownerId: user.role === "admin" ? f.ownerId : undefined,
        version: customer?.version,
        next: f.next || undefined,
        allowDuplicate: allow,
      },
      () => {
        notify(customer ? "客户修改成功" : "客户添加成功");
        refresh();
        close();
      },
    );
    if (
      result instanceof ApiError &&
      (result.details as { duplicates?: unknown })?.duplicates
    )
      setDuplicates(
        (result.details as { duplicates: { id: string; company: string }[] })
          .duplicates,
      );
  };
  return (
    <Modal
      title={customer ? "编辑客户" : "添加客户"}
      close={close}
      busy={m.busy}
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="公司名称 *" wide>
            <input
              required={!customer?.whatsappWaId}
              autoFocus
              value={company}
              aria-required={!customer?.whatsappWaId}
              onChange={(e) => {
                setCompany(e.target.value);
                setAllow(false);
              }}
              maxLength={200}
            />
          </Field>
          {input("contact", "联系人")}
          {input("country", "国家 / 地区")}
          {input("city", "城市")}
          {input("phone", "电话")}
          {input("whatsapp", "WhatsApp")}
          {input("email", "邮箱", "email")}
          {input("website", "公司网址（含 https://）", "url")}
          {input("product", "感兴趣产品")}
          <Field label="客户等级">
            <select
              value={f.grade}
              onChange={(e) =>
                set("grade", e.target.value as CustomerInput["grade"])
              }
            >
              {grades.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </Field>
          <Field label="销售阶段">
            <select
              value={f.stage}
              onChange={(e) =>
                set("stage", e.target.value as CustomerInput["stage"])
              }
            >
              {stages.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="客户来源">
            <input
              list="sources"
              value={f.source}
              onChange={(e) => set("source", e.target.value)}
            />
            <datalist id="sources">
              {sources.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
          {user.role === "admin" && (
            <Field label="负责人">
              <select
                value={f.ownerId}
                onChange={(e) => set("ownerId", e.target.value)}
              >
                {team.data
                  ?.filter((u) => u.active || u.id === f.ownerId)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                      {!u.active ? "（停用）" : ""}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          {input("quantity", "预计采购数量")}
          <Field label="预计订单金额">
            <input
              type="number"
              min={0}
              step="0.01"
              value={f.estimatedValue}
              onChange={(e) => set("estimatedValue", Number(e.target.value))}
            />
          </Field>
          <Field label="币种">
            <select
              value={f.currency}
              onChange={(e) =>
                set("currency", e.target.value as CustomerInput["currency"])
              }
            >
              {["USD", "EUR", "GBP", "CNY", "AUD"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="下次跟进日期（留空按等级自动计算）">
            <input
              type="date"
              value={f.next || ""}
              onChange={(e) => set("next", e.target.value)}
            />
          </Field>
          <Field label="标签（用逗号分隔）" wide>
            <input
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
            />
          </Field>
          <Field label="客户需求" wide>
            <textarea
              value={f.inquiry}
              onChange={(e) => set("inquiry", e.target.value)}
            />
          </Field>
          <Field label="内部备注" wide>
            <textarea
              value={f.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </Field>
        </div>
        <ErrorBox message={m.error} />
        {duplicates.length > 0 && (
          <div className="info">
            <b>发现疑似重复客户</b>
            {duplicates.map((d) => (
              <p key={d.id}>
                <Link to={`/customers/${d.id}`} onClick={close}>
                  {d.company} · 查看已有客户
                </Link>
              </p>
            ))}
            <label className="check-label">
              <input
                type="checkbox"
                checked={allow}
                onChange={(e) => setAllow(e.target.checked)}
              />
              已核对，仍然创建 / 保存
            </label>
          </div>
        )}
        <div className="form-actions">
          <button type="button" onClick={close} disabled={m.busy}>
            取消
          </button>
          <button className="primary" disabled={m.busy}>
            {m.busy ? "保存中…" : "保存客户"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function FollowForm({
  customer,
  close,
}: {
  customer: Customer;
  close: () => void;
}) {
  const { notify, refresh, settings } = useSession(),
    m = useMutation(),
    [method, setMethod] = useState("WhatsApp"),
    [content, setContent] = useState(""),
    [response, setResponse] = useState(""),
    [plan, setPlan] = useState(""),
    [next, setNext] = useState("");
  return (
    <Modal title={`跟进 · ${customer.company}`} close={close} busy={m.busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void m.run(
            `/customers/${customer.id}/follow-ups`,
            "POST",
            {
              method,
              content,
              response,
              plan,
              next: next || undefined,
              version: customer.version,
            },
            () => {
              notify("跟进记录已保存");
              refresh();
              close();
            },
          );
        }}
      >
        <div className="form-grid">
          <Field label="跟进方式">
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {methods.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
          <Field label="下次跟进日期">
            <input
              type="date"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <p className="info wide">
            留空时按 {customer.grade} 级规则，在今天之后{" "}
            {settings.cycles[customer.grade]} 天跟进（{settings.timezone}）。
          </p>
          <Field label="本次跟进内容 *" wide>
            <textarea
              required
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </Field>
          <Field label="客户反馈" wide>
            <textarea
              value={response}
              onChange={(e) => setResponse(e.target.value)}
            />
          </Field>
          <Field label="下一步计划" wide>
            <textarea value={plan} onChange={(e) => setPlan(e.target.value)} />
          </Field>
        </div>
        <ErrorBox message={m.error} />
        <div className="form-actions">
          <button type="button" disabled={m.busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={m.busy}>
            {m.busy ? "保存中…" : "保存跟进"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function UserForm({
  employee,
  close,
}: {
  employee: User | null;
  close: () => void;
}) {
  const { notify, refresh, reloadSession, user } = useSession(),
    m = useMutation(),
    [f, setF] = useState({
      name: employee?.name || "",
      email: employee?.email || "",
      role: employee?.role || "sales",
      active: employee?.active ?? true,
      password: "",
    });
  return (
    <Modal
      title={employee ? "编辑员工 / 重置密码" : "新增员工"}
      close={close}
      busy={m.busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const input = userSchema.safeParse({
            ...f,
            password: f.password || undefined,
            version: employee?.version,
          });
          if (!input.success) {
            m.setError(input.error.issues.map((i) => i.message).join("；"));
            return;
          }
          void m.run(
            employee ? `/team/${employee.id}` : "/team",
            employee ? "PUT" : "POST",
            input.data,
            () => {
              notify(employee ? "员工已更新，旧会话已撤销" : "员工创建成功");
              refresh();
              close();
              if (employee?.id === user.id) void reloadSession();
            },
          );
        }}
      >
        <div className="form-grid">
          <Field label="姓名 *">
            <input
              required
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
          </Field>
          <Field label="邮箱 *">
            <input
              type="email"
              required
              value={f.email}
              onChange={(e) => setF({ ...f, email: e.target.value })}
            />
          </Field>
          <Field label="角色">
            <select
              value={f.role}
              onChange={(e) =>
                setF({ ...f, role: e.target.value as User["role"] })
              }
            >
              <option value="sales">业务员</option>
              <option value="logistics">物流员</option>
              <option value="technical">技术员</option>
              <option value="admin">管理员</option>
            </select>
          </Field>
          <Field label="状态">
            <select
              value={String(f.active)}
              onChange={(e) =>
                setF({ ...f, active: e.target.value === "true" })
              }
            >
              <option value="true">启用</option>
              <option value="false">停用</option>
            </select>
          </Field>
          <Field
            label={employee ? "新密码（不修改则留空）" : "初始密码 *"}
            wide
          >
            <input
              type="password"
              minLength={12}
              maxLength={128}
              required={!employee}
              autoComplete="new-password"
              value={f.password}
              onChange={(e) => setF({ ...f, password: e.target.value })}
            />
          </Field>
        </div>
        <p className="muted">密码至少12位。编辑员工后，该员工需要重新登录。</p>
        <ErrorBox message={m.error} />
        <div className="form-actions">
          <button type="button" onClick={close} disabled={m.busy}>
            取消
          </button>
          <button className="primary" disabled={m.busy}>
            {m.busy ? "保存中…" : "保存员工"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function DeleteDialog({
  customer,
  restore,
  close,
}: {
  customer: Customer;
  restore: boolean;
  close: () => void;
}) {
  const m = useMutation(),
    { notify, refresh } = useSession();
  return (
    <Modal
      title={restore ? "恢复客户" : "删除客户"}
      close={close}
      busy={m.busy}
    >
      <p>
        {restore ? "确定恢复" : "确定删除"}「{customer.company}」吗？
      </p>
      <p className="muted">删除后可在回收站恢复，跟进历史将保留。</p>
      <ErrorBox message={m.error} />
      <div className="form-actions">
        <button onClick={close} disabled={m.busy}>
          取消
        </button>
        <button
          className={restore ? "primary" : "danger"}
          disabled={m.busy}
          onClick={() =>
            void m.run(
              `/customers/${customer.id}/${restore ? "restore" : "delete"}`,
              "POST",
              { version: customer.version },
              () => {
                notify(restore ? "客户已恢复" : "客户已移入回收站");
                refresh();
                close();
              },
            )
          }
        >
          {m.busy ? "处理中…" : "确认"}
        </button>
      </div>
    </Modal>
  );
}
export function EditCustomerLoader({
  id,
  close,
}: {
  id: string;
  close: () => void;
}) {
  const { data, error, loading } = useResource<{ customer: Customer }>(
    `/customers/${id}`,
  );
  return loading ? (
    <Modal title="读取客户" close={close}>
      <Loading />
    </Modal>
  ) : error ? (
    <Modal title="读取失败" close={close}>
      <ErrorBox message={error} />
    </Modal>
  ) : data ? (
    <CustomerForm customer={data.customer} close={close} />
  ) : null;
}
