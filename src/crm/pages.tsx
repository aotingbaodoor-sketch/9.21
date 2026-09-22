import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type {
  Customer,
  CustomerPage,
  FollowRecord,
  Settings,
  Summary,
  User,
} from "../../shared/contracts.ts";
import { grades, stages } from "../../shared/contracts.ts";
import { api, download, useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import {
  CustomerTable,
  Empty,
  ErrorBox,
  Field,
  GradeBadge,
  Loading,
  Pagination,
  Panel,
  Status,
} from "./ui.tsx";
import { UserForm } from "./forms.tsx";
import {
  WhatsAppAnalytics,
  WhatsAppChat,
  WhatsAppDashboard,
} from "./WhatsApp.tsx";
export type CustomerActions = {
  edit: (c?: Customer) => void;
  follow: (c: Customer) => void;
  remove: (c: Customer, restore?: boolean) => void;
};
export function Dashboard({ edit, follow }: CustomerActions) {
  const { revision } = useSession(),
    { data, error, loading } = useResource<Summary>(
      "/summary",
      revision,
      15000,
    );
  if (loading) return <Loading />;
  if (!data) return <ErrorBox message={error} />;
  const metrics = [
    ["今日待跟进", data.metrics.today, "/follow-ups?status=今日跟进"],
    ["已逾期", data.metrics.overdue, "/follow-ups?status=已逾期"],
    ["A级客户", data.metrics.a, "/customers?grade=A"],
    ["全部客户", data.metrics.total, "/customers"],
    ["本月新增", data.metrics.month, "/analytics"],
  ];
  return (
    <>
      <div className="metrics">
        {metrics.map(([title, value, url]) => (
          <Link className="metric" key={title} to={String(url)}>
            <span>{title}</span>
            <strong>{value}</strong>
          </Link>
        ))}
      </div>
      <WhatsAppDashboard />
      <div className="dashboard-grid">
        <Panel
          title="今天优先跟进"
          action={<Link to="/customers">查看全部客户 →</Link>}
        >
          <CustomerTable
            items={data.priority}
            compact
            onFollow={follow}
            onEdit={edit}
          />
        </Panel>
        <Panel title="快捷操作">
          <div className="quick">
            <button onClick={() => edit()}>＋ 添加客户</button>
            <Link to="/follow-ups">查看今日跟进 →</Link>
            <Link to="/notifications">查看提醒中心 →</Link>
            <Link to="/analytics">查看数据统计 →</Link>
          </div>
          <p className="muted" style={{ marginTop: 20 }}>
            优先处理逾期和今日到期的 A / B 级客户。业务日期：{data.today}。
          </p>
        </Panel>
      </div>
    </>
  );
}
export function Customers({ edit, follow, remove }: CustomerActions) {
  const { user, revision, notify } = useSession(),
    [params, setParams] = useSearchParams(),
    [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState("");
  const { data, error, loading } = useResource<CustomerPage>(
      `/customers?${params}`,
      revision,
      15000,
    ),
    team = useResource<User[]>(
      user.role === "admin" ? "/team" : "/auth/owners",
      revision,
    );
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    next.delete("page");
    setParams(next, { replace: true });
  };
  const field = (key: string, label: string) => (
    <Field label={label}>
      <input
        value={params.get(key) || ""}
        onChange={(e) => set(key, e.target.value)}
      />
    </Field>
  );
  const deleted = params.get("deleted") === "true";
  return (
    <Panel
      title={deleted ? "客户回收站" : "客户管理"}
      action={
        <div className="actions">
          <button
            disabled={exporting}
            onClick={async () => {
              setExporting(true);
              setExportError("");
              try {
                download("奥汀堡CRM-授权客户导出.json", await api("/export"));
                notify("已导出当前账号有权访问的全部客户及跟进");
              } catch (e) {
                setExportError((e as Error).message);
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting ? "导出中…" : "导出数据"}
          </button>
          <button className="primary" onClick={() => edit()}>
            ＋ 添加客户
          </button>
        </div>
      }
    >
      <div className="tabs">
        <button
          className={!deleted ? "selected" : ""}
          onClick={() => set("deleted", "")}
        >
          在跟客户
        </button>
        {user.role === "admin" && (
          <button
            className={deleted ? "selected" : ""}
            onClick={() => set("deleted", "true")}
          >
            回收站
          </button>
        )}
      </div>
      <div className="filters">
        {field("q", "搜索公司、联系人、联系方式")}
        <Field label="等级">
          <select
            value={params.get("grade") || ""}
            onChange={(e) => set("grade", e.target.value)}
          >
            <option value="">全部等级</option>
            {grades.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </Field>
        <Field label="销售阶段">
          <select
            value={params.get("stage") || ""}
            onChange={(e) => set("stage", e.target.value)}
          >
            <option value="">全部阶段</option>
            {stages.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="跟进状态">
          <select
            value={params.get("status") || ""}
            onChange={(e) => set("status", e.target.value)}
          >
            <option value="">全部状态</option>
            {["已逾期", "今日跟进", "即将跟进", "今日已完成"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        {field("country", "国家（精确筛选）")}
        {field("source", "来源（精确筛选）")}
        {field("tag", "标签（精确筛选）")}
        {user.role === "admin" && (
          <Field label="负责人">
            <select
              value={params.get("owner") || ""}
              onChange={(e) => set("owner", e.target.value)}
            >
              <option value="">全部员工</option>
              {team.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <ErrorBox message={error || exportError} />
      {loading ? (
        <Loading />
      ) : (
        data && (
          <>
            <CustomerTable
              items={data.items}
              onFollow={follow}
              onEdit={edit}
              onDelete={
                user.role === "admin" && !deleted ? (c) => remove(c) : undefined
              }
              onRestore={deleted ? (c) => remove(c, true) : undefined}
            />
            <Pagination
              {...data}
              onPage={(p) => {
                const next = new URLSearchParams(params);
                next.set("page", String(p));
                setParams(next);
              }}
            />
          </>
        )
      )}
    </Panel>
  );
}
export function Followups(actions: CustomerActions) {
  const { revision } = useSession(),
    [params, setParams] = useSearchParams(),
    status = params.get("status") || "已逾期",
    page = Number(params.get("page") || 1);
  const { data, error, loading } = useResource<CustomerPage>(
    `/customers?status=${encodeURIComponent(status)}&page=${page}`,
    revision,
  );
  return (
    <Panel title="今日跟进">
      <div className="tabs">
        {["已逾期", "今日跟进", "即将跟进", "今日已完成"].map((s) => (
          <button
            className={s === status ? "selected" : ""}
            key={s}
            onClick={() => setParams({ status: s })}
          >
            {s}
          </button>
        ))}
      </div>
      <p className="muted">
        即将跟进展示未来3天；今日已完成按配置时区内的跟进记录判断。
      </p>
      <ErrorBox message={error} />
      {loading ? (
        <Loading />
      ) : (
        data && (
          <>
            <CustomerTable
              items={data.items}
              onFollow={actions.follow}
              onEdit={actions.edit}
            />
            <Pagination
              {...data}
              onPage={(p) => setParams({ status, page: String(p) })}
            />
          </>
        )
      )}
    </Panel>
  );
}
type RecordPage = {
  items: FollowRecord[];
  page: number;
  pages: number;
  total: number;
};
export function CustomerDetail(actions: CustomerActions) {
  const { id } = useParams(),
    [params, setParams] = useSearchParams(),
    { revision, notify, settings, user } = useSession(),
    [page, setPage] = useState(1);
  const { data, error, loading } = useResource<{
    customer: Customer;
    records: RecordPage;
  }>(`/customers/${id}?page=${page}`, revision);
  if (loading) return <Loading />;
  if (!data) return <ErrorBox message={error} />;
  const c = data.customer;
  const row = (label: string, value: string, href?: string) => (
    <div className="data-row">
      <span>{label}</span>
      <span>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        ) : (
          value || "—"
        )}
        {value && (
          <button
            className="copy"
            onClick={() => {
              navigator.clipboard
                .writeText(value)
                .then(() => notify("已复制"))
                .catch(() => notify("复制失败，请手动复制"));
            }}
          >
            复制
          </button>
        )}
      </span>
    </div>
  );
  return (
    <>
      <Panel
        title={c.company || c.contact || "WhatsApp 新客户"}
        action={
          <div className="actions">
            <Link to="/customers">返回客户列表</Link>
            <button onClick={() => actions.edit(c)}>编辑</button>
            <button className="primary" onClick={() => actions.follow(c)}>
              添加跟进
            </button>
            {user.role === "admin" && (
              <button className="danger" onClick={() => actions.remove(c)}>
                删除
              </button>
            )}
          </div>
        }
      >
        <div className="actions">
          <GradeBadge grade={c.grade} />
          <span>{c.stage}</span>
          <span>负责人：{c.owner}</span>
          <Status customer={c} />
          <span>下次跟进：{c.next}</span>
          {c.firstContactAt && (
            <span>
              首次联系：
              {new Date(c.firstContactAt).toLocaleString("zh-CN", {
                timeZone: settings.timezone,
              })}
            </span>
          )}
          {c.lastContactAt && (
            <span>
              最后联系：
              {new Date(c.lastContactAt).toLocaleString("zh-CN", {
                timeZone: settings.timezone,
              })}
            </span>
          )}
        </div>
      </Panel>
      <div className="tabs">
        <button
          className={params.get("tab") !== "whatsapp" ? "active" : ""}
          onClick={() => setParams({})}
        >
          资料与跟进
        </button>
        <button
          className={params.get("tab") === "whatsapp" ? "active" : ""}
          onClick={() => setParams({ tab: "whatsapp" })}
        >
          WhatsApp 聊天
        </button>
      </div>
      {params.get("tab") === "whatsapp" ? (
        <WhatsAppChat customerId={c.id} />
      ) : (
        <>
          <div className="detail-grid">
            <Panel title="基本信息">
              {row("公司", c.company)}
              {row("联系人", c.contact)}
              {row(
                "国家 / 城市",
                [c.country, c.city].filter(Boolean).join(" / "),
              )}
              {row("电话", c.phone, c.phone ? `tel:${c.phone}` : undefined)}
              {row(
                "WhatsApp",
                c.whatsapp,
                c.whatsapp
                  ? `https://wa.me/${c.whatsapp.replace(/\D/g, "")}`
                  : undefined,
              )}
              {row("邮箱", c.email, c.email ? `mailto:${c.email}` : undefined)}
              {row("网址", c.website, c.website || undefined)}
            </Panel>
            <Panel title="业务信息">
              {row("产品", c.product)}
              {row("数量", c.quantity)}
              {row("预计金额", `${c.estimatedValue} ${c.currency}`)}
              {row("来源", c.source)}
              <h3>客户需求</h3>
              <p>{c.inquiry || "暂无"}</p>
              <h3>内部备注</h3>
              <p>{c.notes || "暂无"}</p>
              {c.tags.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </Panel>
          </div>
          <Panel title="跟进时间线">
            {!data.records.items.length ? (
              <Empty text="暂无跟进记录" />
            ) : (
              <div className="timeline">
                {data.records.items.map((r) => (
                  <article key={r.id}>
                    <b>
                      {new Date(r.date).toLocaleString("zh-CN", {
                        timeZone: settings.timezone,
                      })}{" "}
                      · {r.user} · {r.method}
                    </b>
                    <p>{r.content}</p>
                    {r.response && <p>客户反馈：{r.response}</p>}
                    {r.plan && <p>下一步：{r.plan}</p>}
                    <small>下次跟进：{r.next}</small>
                  </article>
                ))}
              </div>
            )}
            <Pagination {...data.records} onPage={setPage} />
          </Panel>
        </>
      )}
    </>
  );
}
export function Records() {
  const { revision, user, settings } = useSession(),
    [params, setParams] = useSearchParams(),
    { data, error, loading } = useResource<RecordPage>(
      `/records?${params}`,
      revision,
    ),
    team = useResource<User[]>(
      user.role === "admin" ? "/team" : "/auth/owners",
      revision,
    );
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== "page") next.delete("page");
    setParams(next, { replace: true });
  };
  return (
    <Panel title="跟进记录">
      <div className="filters">
        <Field label="搜索客户 / 跟进内容">
          <input
            value={params.get("q") || ""}
            onChange={(e) => set("q", e.target.value)}
          />
        </Field>
        <Field label="开始日期">
          <input
            type="date"
            value={params.get("from") || ""}
            onChange={(e) => set("from", e.target.value)}
          />
        </Field>
        <Field label="结束日期">
          <input
            type="date"
            value={params.get("to") || ""}
            onChange={(e) => set("to", e.target.value)}
          />
        </Field>
        {user.role === "admin" && (
          <Field label="业务员">
            <select
              value={params.get("userId") || ""}
              onChange={(e) => set("userId", e.target.value)}
            >
              <option value="">全部员工</option>
              {team.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <ErrorBox message={error} />
      {loading ? (
        <Loading />
      ) : (
        data && (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间 / 员工</th>
                    <th>客户 / 方式</th>
                    <th>跟进内容</th>
                    <th>客户反馈</th>
                    <th>下一步</th>
                    <th>下次跟进</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {new Date(r.date).toLocaleString("zh-CN", {
                          timeZone: settings.timezone,
                        })}
                        <small>{r.user}</small>
                      </td>
                      <td>
                        <Link to={`/customers/${r.customerId}`}>
                          {r.company}
                        </Link>
                        <small>{r.method}</small>
                      </td>
                      <td>{r.content}</td>
                      <td>{r.response || "—"}</td>
                      <td>{r.plan || "—"}</td>
                      <td>{r.next}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.items.length && <Empty />}
            <Pagination {...data} onPage={(p) => set("page", String(p))} />
          </>
        )
      )}
    </Panel>
  );
}
type Notice = {
  id: string;
  kind: string;
  title: string;
  company: string;
  customerId: string;
  readAt: string | null;
  createdAt: string;
  owner: string;
};
export function Notifications() {
  const { revision, refresh, settings } = useSession(),
    r = useResource<Notice[]>("/notifications", revision, 15000),
    m = useMutation(),
    [filter, setFilter] = useState("全部");
  return (
    <Panel title="提醒中心">
      <div className="tabs">
        {["全部", "未读", "已读"].map((s) => (
          <button
            key={s}
            className={filter === s ? "selected" : ""}
            onClick={() => setFilter(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <ErrorBox message={r.error || m.error} />
      {r.loading ? (
        <Loading />
      ) : (
        r.data
          ?.filter(
            (n) =>
              filter === "全部" || (filter === "未读" ? !n.readAt : !!n.readAt),
          )
          .map((n) => (
            <article
              key={n.id}
              className={`notice ${n.readAt ? "" : "unread"}`}
            >
              <div>
                <Link
                  to={`/customers/${n.customerId}${n.kind.startsWith("whatsapp") ? "?tab=whatsapp" : ""}`}
                >
                  {n.title} · {n.company}
                </Link>
                <p className="muted">
                  {n.owner} ·{" "}
                  {new Date(n.createdAt).toLocaleString("zh-CN", {
                    timeZone: settings.timezone,
                  })}
                </p>
              </div>
              <button
                disabled={m.busy}
                onClick={() =>
                  void m.run(
                    `/notifications/${n.id}/read`,
                    "POST",
                    { read: !n.readAt },
                    refresh,
                  )
                }
              >
                {n.readAt ? "标为未读" : "标为已读"}
              </button>
            </article>
          ))
      )}
      {!r.loading && !r.data?.length && <Empty text="暂无提醒" />}
    </Panel>
  );
}
type TeamUser = User & {
  customers: number;
  a: number;
  today: number;
  overdue: number;
};
export function Team() {
  const { revision } = useSession(),
    r = useResource<TeamUser[]>("/team", revision),
    [edit, setEdit] = useState<User | null | undefined>(undefined);
  return (
    <>
      <Panel
        title="员工管理"
        action={
          <button className="primary" onClick={() => setEdit(null)}>
            ＋ 新增员工
          </button>
        }
      >
        <ErrorBox message={r.error} />
        {r.loading ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>姓名 / 账号</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>负责客户</th>
                  <th>A级</th>
                  <th>今日 / 逾期</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {r.data?.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.name}
                      <small>{u.email}</small>
                    </td>
                    <td>{u.role === "admin" ? "管理员" : "业务员"}</td>
                    <td>{u.active ? "启用" : "停用"}</td>
                    <td>
                      <Link to={`/customers?owner=${u.id}`}>
                        {u.customers} 位客户
                      </Link>
                    </td>
                    <td>{u.a}</td>
                    <td>
                      {u.today} / {u.overdue}
                    </td>
                    <td>
                      <button onClick={() => setEdit(u)}>
                        编辑 / 停用 / 重置密码
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {edit !== undefined && (
        <UserForm employee={edit} close={() => setEdit(undefined)} />
      )}
    </>
  );
}
export function Analytics() {
  const { revision } = useSession(),
    r = useResource<Summary>("/summary", revision, 15000);
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  const d = r.data;
  return (
    <>
      <div className="metrics">
        {[
          ["全部客户", d.metrics.total],
          ["本月新增", d.metrics.month],
          ["本月成交", d.metrics.won],
          ["今日待跟进", d.metrics.today],
          ["已逾期", d.metrics.overdue],
        ].map(([n, v]) => (
          <div className="metric" key={n}>
            <span>{n}</span>
            <strong>{v}</strong>
          </div>
        ))}
      </div>
      <WhatsAppAnalytics />
      <div className="chart-grid">
        {(
          [
            ["ABCD等级分布", d.grades],
            ["国家分布", d.countries],
            ["客户来源", d.sources],
            ["销售阶段", d.stages],
            ["员工负责客户", d.owners],
          ] as [string, { label: string; count: number }[]][]
        ).map(([title, items]) => (
          <Panel title={title} key={title}>
            {!items.length ? (
              <Empty />
            ) : (
              items.map((x) => (
                <div className="bar" key={x.label}>
                  <span>{x.label}</span>
                  <div>
                    <i
                      style={{
                        width: `${(x.count / Math.max(1, d.metrics.total)) * 100}%`,
                      }}
                    />
                  </div>
                  <b>{x.count}</b>
                </div>
              ))
            )}
          </Panel>
        ))}
      </div>
    </>
  );
}
export function SettingsPage() {
  const { settings, user } = useSession();
  return (
    <>
      {user.role === "admin" && (
        <SystemSettings key={settings.version} config={settings} />
      )}
      <Profile key={user.version} />
      <Panel title="我的 WhatsApp">
        <p>连接个人工作号码，查看授权状态、同步模板与处理连接异常。</p>
        <Link to="/whatsapp/account">管理我的 WhatsApp →</Link>
      </Panel>
      {user.role === "admin" && <Audit />}
    </>
  );
}
function SystemSettings({ config }: { config: Settings }) {
  const [f, setF] = useState(config),
    m = useMutation(),
    { notify, refresh, reloadSession } = useSession();
  return (
    <Panel title="系统设置">
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void m.run("/settings", "PUT", f, () => {
            notify("设置保存成功");
            refresh();
            void reloadSession();
          });
        }}
      >
        <div className="form-grid">
          <Field label="系统名称">
            <input
              required
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
          </Field>
          <Field label="公司名称">
            <input
              required
              value={f.company}
              onChange={(e) => setF({ ...f, company: e.target.value })}
            />
          </Field>
          <Field label="业务时区" wide>
            <input
              required
              value={f.timezone}
              list="timezones"
              onChange={(e) => setF({ ...f, timezone: e.target.value })}
            />
            <datalist id="timezones">
              <option>Asia/Shanghai</option>
              <option>UTC</option>
              <option>America/New_York</option>
              <option>Europe/London</option>
            </datalist>
          </Field>
          {grades.map((g) => (
            <Field key={g} label={`${g}级跟进周期（天）`}>
              <input
                required
                type="number"
                min={1}
                max={365}
                value={f.cycles[g]}
                onChange={(e) =>
                  setF({
                    ...f,
                    cycles: { ...f.cycles, [g]: Number(e.target.value) },
                  })
                }
              />
            </Field>
          ))}
        </div>
        <p className="muted">
          周期用于之后的新客户及新跟进；已保存的手动跟进日期不会被批量改动。
        </p>
        <ErrorBox message={m.error} />
        <button className="primary" disabled={m.busy}>
          {m.busy ? "保存中…" : "保存系统设置"}
        </button>
      </form>
    </Panel>
  );
}
function Profile() {
  const { user, notify, reloadSession } = useSession(),
    m = useMutation(),
    [name, setName] = useState(user.name),
    [avatar, setAvatar] = useState(user.avatar || ""),
    [currentPassword, setCurrent] = useState(""),
    [password, setPassword] = useState("");
  return (
    <Panel title="个人资料">
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void m.run(
            "/profile",
            "PUT",
            {
              name,
              avatar,
              version: user.version,
              currentPassword: currentPassword || undefined,
              password: password || undefined,
            },
            () => {
              notify(password ? "密码已修改，请重新登录" : "资料已保存");
              void reloadSession();
            },
          );
        }}
      >
        <div className="form-grid">
          <Field label="姓名">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="登录账号">
            <input disabled value={user.email} />
          </Field>
          <Field label="头像（PNG/JPEG/WebP，小于300KB）" wide>
            {avatar && <img className="avatar" src={avatar} alt="当前头像" />}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 300000) {
                  m.setError("头像不能超过300KB");
                  return;
                }
                const reader = new FileReader();
                reader.onload = () => setAvatar(String(reader.result));
                reader.readAsDataURL(file);
              }}
            />
          </Field>
          <Field label="当前密码（修改密码时填写）">
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="新密码（至少12位，留空不修改）">
            <input
              type="password"
              minLength={12}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>
        <ErrorBox message={m.error} />
        <div className="form-actions">
          <button className="primary" disabled={m.busy}>
            {m.busy ? "保存中…" : "保存个人资料"}
          </button>
        </div>
      </form>
    </Panel>
  );
}
function Audit() {
  const { revision, settings } = useSession(),
    r = useResource<
      {
        id: string;
        action: string;
        entityId: string;
        user: string;
        date: string;
      }[]
    >("/audit", revision);
  return (
    <Panel title="操作日志（最近200条）">
      <ErrorBox message={r.error} />
      {r.loading ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>操作人</th>
                <th>操作</th>
                <th>对象</th>
              </tr>
            </thead>
            <tbody>
              {r.data?.map((a) => (
                <tr key={a.id}>
                  <td>
                    {new Date(a.date).toLocaleString("zh-CN", {
                      timeZone: settings.timezone,
                    })}
                  </td>
                  <td>{a.user}</td>
                  <td>{a.action}</td>
                  <td>{a.entityId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
