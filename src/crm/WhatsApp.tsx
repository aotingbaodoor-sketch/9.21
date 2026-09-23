import { useState } from "react";
import { Link } from "react-router-dom";
import type {
  WaAccount,
  WaChat,
  WaConfigView,
  WaConversation,
  WaMessage,
  WaRules,
  WaTemplate,
} from "../../shared/whatsapp.ts";
import { suggestionLabels } from "../../shared/whatsapp.ts";
import type { User } from "../../shared/contracts.ts";
import { api, useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { Empty, ErrorBox, Field, Loading, Pagination, Panel } from "./ui.tsx";
import { embeddedSignup, loadMetaSdk } from "./whatsapp-signup.ts";
import { LinkedWhatsApp } from './LinkedWhatsApp.tsx';

const statusLabels: Record<string, string> = {
  connected: "已绑定（收发待验收）",
  disconnected: "已断开",
  error: "连接异常",
  unknown: "待确认",
  not_subscribed: "未订阅",
  subscribed: "已订阅",
  pending: "待处理",
  retry: "等待重试",
  processing: "处理中",
  done: "已处理",
  failed: "失败",
  queued: "排队发送",
  sending: "发送中",
  sent: "平台已接收",
  delivered: "已送达",
  read: "已读",
  received: "已收到",
};
const label = (s: string) => statusLabels[s] || s;
function useDate() {
  const { settings } = useSession();
  return (value: string | null | undefined) =>
    value
      ? new Date(value).toLocaleString("zh-CN", { timeZone: settings.timezone })
      : "尚无记录";
}
export type WaSummary = {
  daily: { day: string; count: number }[];
  metrics: {
    total: number;
    today: number;
    won: number;
    pool: number;
    unread: number;
    averageFirstReplyMinutes: number;
    overdueConversations: number;
  };
  employees: {
    id: string;
    name: string;
    customers: number;
    inquiries: number;
    replied: number;
  }[];
  countries: { label: string; count: number }[];
  products: { label: string; count: number }[];
  accounts: WaAccount[];
};
export function WhatsAppBadge() {
  const { revision } = useSession(),
    r = useResource<WaSummary>("/whatsapp/summary", revision, 15000);
  return (
    <Link to="/whatsapp" aria-label="WhatsApp新消息">
      WhatsApp{" "}
      {r.data?.metrics.unread ? (
        <span className="wa-unread">{r.data.metrics.unread}</span>
      ) : null}
    </Link>
  );
}
export function WhatsAppDashboard() {
  const { revision } = useSession(),
    r = useResource<WaSummary>("/whatsapp/summary", revision, 15000);
  return (
    <Panel
      title="WhatsApp新询盘"
      action={<Link to="/whatsapp">打开收件箱 →</Link>}
    >
      <ErrorBox message={r.error} />
      {r.loading ? (
        <Loading />
      ) : r.data ? (
        <div className="wa-metrics">
          <div>
            <strong>{r.data.metrics.today}</strong>
            <span>今日新增客户</span>
          </div>
          <div>
            <strong>{r.data.metrics.unread}</strong>
            <span>未读消息</span>
          </div>
          <div>
            <strong>{r.data.metrics.overdueConversations}</strong>
            <span>超时未回复会话</span>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
export function WhatsAppInbox() {
  const { revision, user } = useSession(),
    [query, setQuery] = useState(""),
    r = useResource<
      {
        id: string;
        name: string;
        preview: string | null;
        lastContactAt: string | null;
      }[]
    >("/whatsapp/inbox", revision, 10000),
    date = useDate();
  const visible = (r.data || []).filter((x) =>
    (x.name + " " + (x.preview || ""))
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <WhatsAppDashboard />
      <Panel
        title="WhatsApp收件箱（最近100位客户）"
        action={<Link to="/whatsapp/account">我的WhatsApp →</Link>}
      >
        <Field label="搜索WhatsApp客户或最近消息">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索姓名、公司、需求…"
          />
        </Field>
        <ErrorBox message={r.error} />
        {r.loading ? (
          <Loading />
        ) : !visible.length ? (
          <Empty text="暂无WhatsApp询盘。连接设备后，新消息会自动创建客户。" />
        ) : (
          <div className="wa-inbox">
            {visible.map((c) => (
              <Link key={c.id} to={`/customers/${c.id}?tab=whatsapp`}>
                <div>
                  <b>{c.name}</b>
                  <small>{date(c.lastContactAt)}</small>
                </div>
                <p>{c.preview || "媒体或其他消息，点击查看"}</p>
              </Link>
            ))}
          </div>
        )}
      </Panel>
      {user.role === "admin" ? <AssignmentPanel /> : <ConflictNotice />}
    </>
  );
}
function ConflictNotice() {
  const { revision } = useSession(),
    r = useResource<{ count: number; message: string }>(
      "/whatsapp/conflicts",
      revision,
      15000,
    );
  return r.data?.count ? (
    <p className="wa-warning">
      {r.data.message}（{r.data.count}个会话）
    </p>
  ) : null;
}
export function MyWhatsApp() {
  return <><LinkedWhatsApp /><details><summary>旧版官方 Cloud API 配置（保留，不作为扫码前提）</summary><CloudWhatsApp /></details></>;
}
function CloudWhatsApp() {
  const { revision } = useSession(),
    r = useResource<WaConfigView>("/whatsapp/config", revision, 15000);
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  return (
    <>
      <Panel title="我的WhatsApp">
        <p>
          只通过Meta官方Cloud API接收接入后的新消息，不控制WhatsApp
          Web，不承诺同步历史聊天。
        </p>
        <ConnectAccount config={r.data} />
      </Panel>
      {r.data.accounts.filter(a=>!a.phoneNumberId.startsWith('linked:')).map((a) => (
        <AccountCard key={a.id} account={a} />
      ))}
      {!r.data.accounts.length && (
        <Empty text="你尚未绑定WhatsApp。请先让管理员完成服务端配置，再使用官方授权连接。" />
      )}
      <ConflictNotice />
      <ConnectionGuide />
    </>
  );
}
function ConnectAccount({ config }: { config: WaConfigView }) {
  const [confirmed, setConfirmed] = useState(false),
    [sessionId, setSessionId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    { refresh, notify } = useSession();
  if (!config.signupAvailable)
    return (
      <div className="wa-warning">
        官方自主授权尚未启用：需要公司HTTPS网址、Meta App、Embedded
        Signup配置及服务端机密。现有公司Cloud
        API号码也可由部署人员使用安全的服务端绑定命令接入。
        <Link to="/whatsapp/integration"> 查看集成状态</Link>
      </div>
    );
  return (
    <div>
      <label className="wa-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        我已确认此号码可用于官方Cloud API；若仍在Business
        App使用，已由管理员核验Coexistence资格与历史影响。此流程不授权自动注销或迁移号码。
      </label>
      <ErrorBox message={error} />
      {!sessionId ? (
        <button
          className="primary"
          disabled={!confirmed || busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await loadMetaSdk(config);
              const result = await api<{ id: string }>(
                "/whatsapp/signup/start",
                "POST",
                { existingCloudApiConfirmed: true },
              );
              setSessionId(result.id);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "准备中…" : "准备Meta官方授权"}
        </button>
      ) : (
        <button
          className="primary"
          disabled={busy || !confirmed}
          onClick={() => {
            setBusy(true);
            setError("");
            void embeddedSignup(config)
              .then((result) =>
                api("/whatsapp/signup/complete", "POST", {
                  ...result,
                  sessionId,
                }),
              )
              .then(() => {
                notify("WhatsApp已通过官方授权绑定");
                refresh();
              })
              .catch((e) => setError(e.message))
              .finally(() => {
                setBusy(false);
                setSessionId("");
              });
          }}
        >
          {busy ? "等待官方授权…" : "打开Meta官方授权"}
        </button>
      )}
    </div>
  );
}
function AccountCard({ account: a }: { account: WaAccount }) {
  const { user, refresh, notify } = useSession(),
    m = useMutation(),
    date = useDate(),
    [disconnect, setDisconnect] = useState(false),
    [assign, setAssign] = useState(false),
    [owner, setOwner] = useState(a.userId),
    team = useResource<User[]>(
      user.role === "admin" ? "/team" : "/auth/owners",
    );
  return (
    <Panel
      title={`${a.displayPhoneNumber} · ${a.verifiedName || "未设置显示名称"}`}
      action={
        <span className={`wa-connection ${a.connectionStatus}`}>
          {label(a.connectionStatus)}
        </span>
      }
    >
      <div className="wa-account-grid">
        {[
          ["员工", a.userName],
          ["国家区号", a.countryCallingCode || "Meta未提供（请核对显示号码）"],
          ["WABA ID", a.wabaId],
          ["Phone Number ID", a.phoneNumberId],
          ["绑定时间", date(a.connectedAt)],
          ["最近接收", date(a.lastWebhookAt)],
          ["Webhook订阅", label(a.subscriptionStatus)],
          ["最近检查", date(a.lastCheckedAt)],
          [
            "服务端凭据",
            a.credentialConfigured ? "已配置（不可查看）" : "未配置",
          ],
        ].map(([name, value]) => (
          <div key={name}>
            <small>{name}</small>
            <span>{value}</span>
          </div>
        ))}
      </div>
      {!a.active && (
        <p className="wa-warning">
          绑定员工已停用，新入站由管理员核对归属；不能继续发送。
        </p>
      )}
      <ErrorBox message={a.lastError || ""} />
      <ErrorBox message={m.error} />
      <div className="actions">
        {a.connectionStatus !== "disconnected" && (
          <>
            <button
              disabled={m.busy}
              onClick={() =>
                void m.run(
                  `/whatsapp/accounts/${a.id}/test`,
                  "POST",
                  {},
                  () => {
                    refresh();
                    notify("连接检查完成，请核对Webhook订阅状态");
                  },
                )
              }
            >
              测试连接
            </button>
            <button onClick={() => setDisconnect(!disconnect)}>断开连接</button>
            <button
              disabled={m.busy}
              onClick={() =>
                void m.run(
                  `/whatsapp/accounts/${a.id}/templates/sync`,
                  "POST",
                  {},
                  () => {
                    refresh();
                    notify("已同步Meta模板");
                  },
                )
              }
            >
              同步审核模板
            </button>
          </>
        )}
        <Link to="/whatsapp/account">重新连接说明</Link>
        {user.role === "admin" && (
          <button onClick={() => setAssign(!assign)}>调整绑定员工</button>
        )}
      </div>
      {disconnect && (
        <div className="wa-warning">
          <p>
            仅断开CRM并清除本地服务端凭据，不删除号码、客户或聊天。Meta订阅不会自动撤销，后续事件保留等待管理员处理。
          </p>
          <button
            className="danger"
            disabled={m.busy}
            onClick={() =>
              void m.run(
                `/whatsapp/accounts/${a.id}/disconnect`,
                "POST",
                { version: a.version, confirm: true },
                () => {
                  setDisconnect(false);
                  refresh();
                  notify("CRM连接已断开，历史已保留");
                },
              )
            }
          >
            确认断开
          </button>{" "}
          <button onClick={() => setDisconnect(false)}>取消</button>
        </div>
      )}
      {assign && (
        <form
          className="wa-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void m.run(
              `/whatsapp/accounts/${a.id}/assign`,
              "POST",
              { version: a.version, userId: owner },
              () => {
                setAssign(false);
                refresh();
                notify("号码员工映射已更新，客户归属未自动更改");
              },
            );
          }}
        >
          <Field label="绑定员工">
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              {team.data
                ?.filter((u) => u.active)
                .map((u) => (
                  <option value={u.id} key={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </Field>
          <button disabled={m.busy}>保存号码映射</button>
        </form>
      )}
      <TemplateList accountId={a.id} />
    </Panel>
  );
}
function TemplateList({ accountId }: { accountId: string }) {
  const { revision } = useSession(),
    r = useResource<WaTemplate[]>(
      `/whatsapp/accounts/${accountId}/templates`,
      revision,
    );
  return (
    <details>
      <summary>查看已同步模板（{r.data?.length || 0}）</summary>
      <ErrorBox message={r.error} />
      {!r.data?.length ? (
        <p className="muted">尚未同步模板。</p>
      ) : (
        <ul>
          {r.data.map((t) => (
            <li key={t.id}>
              {t.name} · {t.language} · {t.status} · {t.parameterCount}个参数
              {!t.supported ? "（含本版未支持的动态媒体/按钮，仅展示）" : ""}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
function RuleForm({ config }: { config: WaRules }) {
  const [f, setF] = useState(config),
    [minutes, setMinutes] = useState(config.reminderMinutes.join(",")),
    m = useMutation(),
    { refresh, notify } = useSession();
  return (
    <Panel title="入站归属与未回复提醒">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void m.run(
            "/whatsapp/settings",
            "PUT",
            { ...f, reminderMinutes: minutes.split(/[,，]/).map(Number) },
            () => {
              refresh();
              notify("WhatsApp规则已保存");
            },
          );
        }}
      >
        <Field label="客户重新分配后，又向原号码发消息">
          <select
            value={f.reassignmentPolicy}
            onChange={(e) =>
              setF({
                ...f,
                reassignmentPolicy: e.target
                  .value as WaRules["reassignmentPolicy"],
              })
            }
          >
            <option value="keep">保持当前负责人（推荐）</option>
            <option value="number_owner">改归号码当前绑定员工</option>
            <option value="pool">进入管理员待分配池</option>
          </select>
        </Field>
        <Field label="未回复提醒阈值（分钟，逗号分隔）">
          <input
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            required
          />
        </Field>
        <p className="muted">
          新发现的跨员工重复始终先交管理员确认；此规则不会自动开放其他员工的聊天。
        </p>
        <ErrorBox message={m.error} />
        <button className="primary" disabled={m.busy}>
          {m.busy ? "保存中…" : "保存WhatsApp规则"}
        </button>
      </form>
    </Panel>
  );
}
export function WhatsAppIntegration() {
  const { user, revision, refresh, notify } = useSession(),
    r = useResource<WaConfigView>("/whatsapp/config", revision, 15000),
    m = useMutation(),
    date = useDate();
  if (user.role !== "admin") return <ConnectionGuide />;
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  const c = r.data;
  return (
    <>
      <Panel title="接入设置与真实验收">
        <p>页面可用 ≠ 后台已配置 ≠ 手机真实收发已通过。当前为单公司部署，员工共用公司的 Meta 应用，各自绑定获授权的业务号码。</p>
        <ol>
          {(c.setupChecks || []).map(check => <li key={check.id}>
            <b>{check.label}：{check.configured ? "已配置" : check.required ? "缺失" : "可选，未配置"}</b>
            <p>{check.nextStep}</p>
          </li>)}
        </ol>
        <p>号码类型须先核实：普通 WhatsApp 不能直接扫码接入；Business 手机 App 号码须由 Meta 核实共存资格和影响；已有 Cloud API 号码优先由管理员绑定。本系统不会自动注册、注销或迁移号码，不同步全部历史聊天。</p>
        <a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">打开 Meta 官方应用控制台 ↗</a>
        <h3>逐号码消息证据</h3>
        {(c.messageEvidence || []).length === 0 ? <Empty text="尚无绑定号码，未开始真实收发验收" /> : (c.messageEvidence || []).map(e => {
          const a = c.accounts.find(account => account.id === e.accountId);
          return <div key={e.accountId} className="wa-warning">
            <b>{a?.displayPhoneNumber || "业务号码"} · {a?.userName}</b>
            <p>已保存入站：{e.inboundCount}；平台已接收回复：{e.acceptedCount}；已送达回执：{e.deliveredCount}</p>
            <p>最近入站：{date(e.lastInboundAt)}；最近送达：{date(e.lastDeliveredAt)}</p>
            <small>这些是服务端记录，不区分 Meta 测试事件与人工手机验收。仍须测试手机确认收发、客户归属和双员工隔离；历史成功不代表当前凭据仍有效。</small>
          </div>;
        })}
        <p className="muted">当前自动回复未启用，所有外发均需人工操作；不会自动承诺价格、交期或合同。图片／PDF外发和聊天建询价尚待补齐，不能仅凭本页宣布全部接通。</p>
      </Panel>
      <Panel
        title="WhatsApp集成状态"
        action={<Link to="/whatsapp/account">号码连接管理 →</Link>}
      >
        <div className="wa-account-grid">
          {[
            ["Meta App ID", c.appId || "未配置"],
            ["Graph API版本", c.graphVersion || "未配置"],
            ["App Secret", c.appSecretConfigured ? "已配置" : "未配置"],
            [
              "Webhook Verify Token",
              c.verifyTokenConfigured ? "已配置" : "未配置",
            ],
            ["服务端加密密钥", c.encryptionKeyConfigured ? "已配置" : "未配置"],
            ["官方自主授权", c.signupAvailable ? "可用" : "未配置或缺少HTTPS"],
            ["最近订阅验证", date(c.lastVerifiedAt)],
            ["最近Webhook接收", date(c.lastReceivedAt)],
            ["签名验证失败次数", String(c.signatureFailures)],
          ].map(([name, value]) => (
            <div key={name}>
              <small>{name}</small>
              <span>{value}</span>
            </div>
          ))}
        </div>
        <p className="wa-url">
          Webhook回调地址：<code>{c.callbackUrl}</code>
        </p>
        {!c.publicHttps && (
          <p className="wa-warning">
            当前仅本机地址，Meta不能回调。必须完成公司公网HTTPS部署后再配置真实接入。
          </p>
        )}
        <p>
          安全值仅显示配置状态，不能在浏览器查看永久Token。测试接收：在Meta发送Webhook测试或让测试客户给已连接的测试号码发消息。测试发送：打开自动录入客户的WhatsApp聊天，人工发送；不提供无目标的一键群发。
        </p>
        <div className="actions">
          <Link to="/whatsapp">查看接收结果 / 测试回复 →</Link>
        </div>
      </Panel>
      <RuleForm key={c.rules.version} config={c.rules} />
      <Panel title="连接异常与待处理提醒">
        {c.alerts.length ? (
          c.alerts.map((a) => (
            <div className="wa-warning" key={a.id}>
              <b>{a.title}</b>
              <small>
                {a.code} · {date(a.createdAt)}
              </small>
            </div>
          ))
        ) : (
          <Empty text="暂无已记录的集成异常（不代表真实号码已验收）" />
        )}
      </Panel>
      <Panel title="最近Webhook事件">
        <ErrorBox message={m.error} />
        {!c.events.length ? (
          <Empty text="尚未接收Webhook，真实接入待验证" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>收到时间</th>
                  <th>状态 / 尝试次数</th>
                  <th>错误</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {c.events.map((e) => (
                  <tr key={e.id}>
                    <td>{date(e.receivedAt)}</td>
                    <td>
                      {label(e.status)} / {e.attempts}
                    </td>
                    <td>{e.errorMessage || "—"}</td>
                    <td>
                      {["failed", "retry"].includes(e.status) ? (
                        <button
                          disabled={m.busy}
                          onClick={() =>
                            void m.run(
                              `/whatsapp/events/${e.id}/retry`,
                              "POST",
                              {},
                              () => {
                                refresh();
                                notify("事件已重新排队");
                              },
                            )
                          }
                        >
                          重试接收处理
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <AssignmentPanel />
      <ConnectionGuide />
    </>
  );
}
function ConnectionGuide() {
  return (
    <Panel title="官方连接说明">
      <ol>
        <li>
          在Meta Business Portfolio中创建或选择企业，创建Meta
          App并添加WhatsApp产品。
        </li>
        <li>先使用Meta测试号码，确认WABA、Phone Number ID与业务显示名称。</li>
        <li>
          在服务器配置App ID、App Secret、Verify
          Token、Graph版本和独立加密密钥；秘密不得粘贴到客户或聊天。
        </li>
        <li>
          将本系统公网HTTPS Webhook地址填入Meta，验证后订阅messages事件及WABA。
        </li>
        <li>
          公司已有Cloud
          API号码由服务器安全绑定到CRM员工；员工独立账号使用正式Embedded
          Signup授权，不提供WhatsApp密码。
        </li>
        <li>
          测试客户发消息后，核对自动录入、负责人、消息幂等和回复送达，再接入正式业务号码。
        </li>
      </ol>
      <p className="wa-warning">
        现有WhatsApp Business
        App号码：先由号码持有人在Meta确认Coexistence资格、地区及账号支持、App能否继续使用和历史影响。CRM不会自动注册、迁移、注销或删除号码。历史同步未实现；仅承诺已接入后新消息进入处理链路。
      </p>
      <a
        href="https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api"
        target="_blank"
        rel="noreferrer"
      >
        查看Meta官方Cloud API参考 ↗
      </a>
    </Panel>
  );
}
type Conflict = {
  id: string;
  customerId: string;
  company: string;
  ownerId: string;
  owner: string;
  receiver: string;
  displayPhoneNumber: string;
  version: number;
  deletedAt: string | null;
  reason: string;
};
function AssignmentPanel() {
  const { revision, user, refresh, notify } = useSession(),
    [sourceOwner, setSourceOwner] = useState(""),
    [page, setPage] = useState(1),
    conflicts = useResource<{ items: Conflict[] }>(
      "/whatsapp/conflicts",
      revision,
      15000,
    ),
    inbox = useResource<{
      items: { id: string; name: string; ownerId: string; version: number }[];
      page: number;
      pages: number;
      total: number;
    }>(
      `/whatsapp/assignment-candidates?page=${page}${sourceOwner ? "&ownerId=" + sourceOwner : ""}`,
      revision,
    ),
    team = useResource<User[]>(
      user.role === "admin" ? "/team" : "/auth/owners",
      revision,
    ),
    [selected, setSelected] = useState<string[]>([]),
    [target, setTarget] = useState(""),
    [reason, setReason] = useState("管理员核对后调整归属"),
    m = useMutation();
  if (user.role !== "admin") return null;
  const rows = new Map<
    string,
    {
      id: string;
      name: string;
      owner: string;
      version: number;
      reason: string;
      deleted: boolean;
    }
  >();
  for (const c of inbox.data?.items || [])
    rows.set(c.id, {
      id: c.id,
      name: c.name,
      owner: team.data?.find((u) => u.id === c.ownerId)?.name || "",
      version: c.version,
      reason: "普通WhatsApp客户",
      deleted: false,
    });
  for (const c of conflicts.data?.items || [])
    if (!sourceOwner || c.ownerId === sourceOwner)
      rows.set(c.customerId, {
        id: c.customerId,
        name: c.company,
        owner: c.owner,
        version: c.version,
        reason: `${c.reason} · 接收员工：${c.receiver}`,
        deleted: !!c.deletedAt,
      });
  return (
    <Panel title="管理员归属处理 / 批量移交">
      <p>
        核对疑似跨员工重复，或把离职员工的WhatsApp客户移交给在职员工。历史保留，原员工立即失去客户访问权限。
      </p>
      <ErrorBox message={m.error || conflicts.error || inbox.error} />
      <Field label="筛选当前负责人（含已停用员工）">
        <select
          value={sourceOwner}
          onChange={(e) => {
            setSourceOwner(e.target.value);
            setPage(1);
            setSelected([]);
          }}
        >
          <option value="">全部负责人</option>
          {team.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
              {u.active ? "" : "（已停用）"}
            </option>
          ))}
        </select>
      </Field>
      {inbox.data && (
        <Pagination
          {...inbox.data}
          onPage={(v) => {
            setPage(v);
            setSelected([]);
          }}
        />
      )}
      {!rows.size ? (
        <Empty text="暂无待处理或可移交的WhatsApp客户" />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const targets = [...rows.values()].filter((c) =>
              selected.includes(c.id),
            );
            void m.run(
              "/whatsapp/assignments",
              "POST",
              {
                customers: targets.map((c) => ({
                  id: c.id,
                  version: c.version,
                })),
                ownerId: target,
                reason,
              },
              () => {
                setSelected([]);
                refresh();
                notify("客户已移交，历史保留");
              },
            );
          }}
        >
          <div className="wa-assignment-list">
            {[...rows.values()].map((c) => (
              <label key={c.id} className="wa-check">
                <input
                  type="checkbox"
                  disabled={c.deleted}
                  checked={selected.includes(c.id)}
                  onChange={(e) =>
                    setSelected((v) =>
                      e.target.checked
                        ? [...v, c.id]
                        : v.filter((x) => x !== c.id),
                    )
                  }
                />
                <span>
                  <b>{c.name}</b> · 当前负责人：{c.owner}
                  <small>
                    {c.reason}
                    {c.deleted ? "；请先在回收站恢复" : ""}
                  </small>
                </span>
              </label>
            ))}
          </div>
          <div className="form-grid">
            <Field label="新的负责人">
              <select
                required
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">请选择员工</option>
                {team.data
                  ?.filter((u) => u.active)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="分配原因">
              <input
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </div>
          <button className="primary" disabled={m.busy || !selected.length}>
            {m.busy ? "保存中…" : `确认分配选中的${selected.length}位客户`}
          </button>
        </form>
      )}
    </Panel>
  );
}
export function WhatsAppAnalytics() {
  const { revision } = useSession(),
    r = useResource<WaSummary>("/whatsapp/summary", revision, 15000);
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  const d = r.data;
  return (
    <>
      <Panel title="WhatsApp销售统计（按当前客户权限）">
        <div className="wa-metrics">
          {[
            ["WhatsApp客户", d.metrics.total],
            ["今日新增", d.metrics.today],
            ["已成交", d.metrics.won],
            ["超时会话", d.metrics.overdueConversations],
            [
              "平均首次回复/分钟",
              d.metrics.averageFirstReplyMinutes.toFixed(1),
            ],
          ].map(([name, value]) => (
            <div key={name}>
              <strong>{value}</strong>
              <span>{name}</span>
            </div>
          ))}
        </div>
        <p className="muted">
          首次回复时间从会话第一条入站到首次成功发出计算；未回复会话不纳入平均。员工汇总按当前负责人，不回写原接收记录。
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>员工</th>
                <th>当前客户</th>
                <th>收到询盘客户</th>
                <th>已回复客户</th>
              </tr>
            </thead>
            <tbody>
              {d.employees.map((e) => (
                <tr key={e.id}>
                  <td>{e.name}</td>
                  <td>{e.customers}</td>
                  <td>{e.inquiries}</td>
                  <td>{e.replied}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="chart-grid">
        {[
          ["客户确认的国家", d.countries],
          ["客户确认的产品", d.products],
        ].map(([title, values]) => (
          <Panel key={String(title)} title={String(title)}>
            {(values as { label: string; count: number }[]).map((x) => (
              <div className="data-row" key={x.label}>
                <span>{x.label}</span>
                <b>{x.count}</b>
              </div>
            ))}
          </Panel>
        ))}
      </div>
      <Panel title="每日新增WhatsApp客户（近30天）">
        {d.daily.length ? (
          d.daily.map((x) => (
            <div className="data-row" key={x.day}>
              <span>{x.day}</span>
              <b>{x.count}</b>
            </div>
          ))
        ) : (
          <Empty />
        )}
        <p className="muted">
          按公司业务时区统计；未列出的日期为0，范围随当前客户权限变化。
        </p>
      </Panel>
      <Panel title="各员工号码与Webhook状态">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>员工</th>
                <th>号码</th>
                <th>连接</th>
                <th>Webhook</th>
              </tr>
            </thead>
            <tbody>
              {d.accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.userName}</td>
                  <td>{a.displayPhoneNumber}</td>
                  <td>{label(a.connectionStatus)}</td>
                  <td>
                    {label(a.subscriptionStatus)} ·{" "}
                    {a.lastWebhookAt ? "已接收" : "尚无记录"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
export function WhatsAppChat({ customerId }: { customerId: string }) {
  const { revision, refresh, notify } = useSession(),
    [page, setPage] = useState(1),
    r = useResource<WaChat>(
      `/whatsapp/customers/${customerId}/chat?page=${page}`,
      revision,
      5000,
    ),
    m = useMutation(),
    date = useDate(),
    [quote, setQuote] = useState<WaMessage | null>(null);
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  const d = r.data;
  return (
    <>
      <Panel title="WhatsApp聊天">
        <p className="muted">
          记录按时间排列；第1页显示最新50条，翻页可查看更早记录。仅显示你有权访问的会话。
        </p>
        <ErrorBox message={m.error} />
        {d.needsAssignment && (
          <p className="wa-warning">
            此客户在管理员待分配池，确认归属后才能回复。
          </p>
        )}
        {!d.conversations.length ? (
          <Empty text="尚无可查看的WhatsApp会话。客户发送新消息后会自动建立。" />
        ) : (
          <>
            <div className="actions">
              {d.conversations.map((v) => (
                <button
                  key={v.id}
                  disabled={m.busy}
                  onClick={() =>
                    void m.run(
                      `/whatsapp/conversations/${v.id}/read`,
                      "POST",
                      {},
                      () => {
                        refresh();
                        notify("会话已标记已读");
                      },
                    )
                  }
                >
                  标记 {v.displayPhoneNumber} 已读
                </button>
              ))}
            </div>
            <div className="wa-chat" aria-label="WhatsApp消息记录">
              {d.messages.map((message) => (
                <article
                  className={`wa-message ${message.direction}`}
                  key={message.id}
                >
                  <small>
                    {message.direction === "outbound"
                      ? "CRM → 客户"
                      : "客户 → CRM"}{" "}
                    · {date(message.messageTimestamp)}
                  </small>
                  {message.replyToMessageId && (
                    <blockquote>
                      引用：{message.quotedText || message.replyToMessageId}
                    </blockquote>
                  )}
                  {message.textContent && <p>{message.textContent}</p>}
                  <MessageMedia message={message} />
                  <small>
                    {label(message.deliveryStatus)} · {message.ownerName}
                  </small>
                  {message.errorMessage && (
                    <ErrorBox
                      message={`${message.errorMessage}${message.errorCode ? "（" + message.errorCode + "）" : ""}`}
                    />
                  )}
                  <div className="actions">
                    {message.whatsappMessageId &&
                      d.conversations.some(
                        (v) => v.id === message.conversationId && v.canSend,
                      ) && (
                        <button onClick={() => setQuote(message)}>
                          引用回复
                        </button>
                      )}
                    {message.deliveryStatus === "failed" &&
                      message.direction === "outbound" && (
                        <button
                          disabled={m.busy}
                          onClick={() =>
                            void m.run(
                              `/whatsapp/messages/${message.id}/retry`,
                              "POST",
                              {},
                              () => {
                                refresh();
                                notify("已重新排队，将再次检查窗口和权限");
                              },
                            )
                          }
                        >
                          重试发送
                        </button>
                      )}
                  </div>
                </article>
              ))}
            </div>
            <Pagination {...d} onPage={setPage} />
            <Composer
              conversations={d.conversations}
              quote={quote}
              clearQuote={() => setQuote(null)}
            />
          </>
        )}
      </Panel>
      {d.suggestions.length > 0 && (
        <Panel title="待确认信息（本地规则提取，不是AI事实）">
          <p>
            先核对原文。确认会修改正式客户字段；忽略不会删除消息。姓名、公司、国家等不会被系统猜测后自动填入。
          </p>
          {d.suggestions.map((s) => (
            <div className="wa-suggestion" key={s.id}>
              <b>
                {suggestionLabels[s.field] || s.field}：{s.value}
              </b>
              <blockquote>{s.evidence}</blockquote>
              <div className="actions">
                {[true, false].map((accept) => (
                  <button
                    key={String(accept)}
                    disabled={m.busy}
                    onClick={() =>
                      void m.run(
                        `/whatsapp/suggestions/${s.id}/review`,
                        "POST",
                        { accept, version: d.customerVersion },
                        () => {
                          refresh();
                          notify(
                            accept ? "已确认写入客户资料" : "已忽略此项提取",
                          );
                        },
                      )
                    }
                  >
                    {accept ? "确认写入" : "忽略"}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </Panel>
      )}
      <Panel title="WhatsApp归属历史">
        {d.assignments.length ? (
          d.assignments.map((a) => (
            <p key={a.id}>
              {date(a.createdAt)} · {a.fromName || "首次接收"} → {a.toName} ·{" "}
              {a.reason}
            </p>
          ))
        ) : (
          <Empty />
        )}
      </Panel>
    </>
  );
}
function MessageMedia({ message: m }: { message: WaMessage }) {
  const mutation = useMutation(),
    { refresh } = useSession();
  if (m.mediaId) {
    const url = `/api/whatsapp/messages/${m.id}/media`;
    return (
      <div>
        {m.mediaStatus === "ready" ? (
          <>
            {m.messageType === "image" || m.messageType === "sticker" ? (
              <img
                className="wa-media"
                src={url}
                alt="客户发来的图片"
                loading="lazy"
              />
            ) : m.messageType === "audio" ? (
              <audio controls preload="none" src={url} />
            ) : m.messageType === "video" ? (
              <video className="wa-media" controls preload="none" src={url} />
            ) : null}
            <a href={url} download>
              {m.mediaFilename || "下载媒体文件"}
            </a>
          </>
        ) : (
          <p>
            媒体{m.mediaStatus === "failed" ? "下载失败" : "等待安全下载"}
            （通过服务端鉴权，不暴露Token）
            {m.mediaStatus === "failed" && (
              <button
                disabled={mutation.busy}
                onClick={() =>
                  void mutation.run(
                    `/whatsapp/messages/${m.id}/media/retry`,
                    "POST",
                    {},
                    refresh,
                  )
                }
              >
                重试下载
              </button>
            )}
          </p>
        )}
        <ErrorBox message={mutation.error} />
      </div>
    );
  }
  if (m.messageType === "contacts")
    return (
      <>
        <b>联系人卡片</b>
        <pre>{JSON.stringify(m.content.contacts, null, 2)}</pre>
      </>
    );
  if (m.messageType === "location") {
    const location = m.content.location as
      | {
          name?: string;
          address?: string;
          latitude?: number;
          longitude?: number;
        }
      | undefined;
    return (
      <>
        <b>客户发送的地址</b>
        <p>
          {location?.name} {location?.address}
        </p>
        <small>
          坐标：{location?.latitude}, {location?.longitude}
        </small>
      </>
    );
  }
  if (!["text", "template"].includes(m.messageType))
    return (
      <p className="muted">
        {["interactive", "button"].includes(m.messageType)
          ? "互动回复：" + JSON.stringify(m.content)
          : `暂不支持预览的消息类型：${m.messageType}。事件已保存。`}
      </p>
    );
  return null;
}
function Composer({
  conversations,
  quote,
  clearQuote,
}: {
  conversations: WaConversation[];
  quote: WaMessage | null;
  clearQuote: () => void;
}) {
  const [chosen, setChosen] = useState(""),
    [text, setText] = useState(""),
    [templateId, setTemplate] = useState(""),
    [parameters, setParameters] = useState<string[]>([]),
    [consent, setConsent] = useState(false),
    { refresh, notify, revision } = useSession(),
    m = useMutation();
  const allowed = conversations.filter((v) => v.canSend),
    selected =
      allowed.find((v) => v.id === quote?.conversationId) ||
      allowed.find((v) => v.id === chosen) ||
      allowed[0];
  return (
    <div className="wa-composer">
      <h3>人工回复WhatsApp</h3>
      {!selected ? (
        <p className="wa-warning">
          当前没有你可使用的已连接号码。客户移交后，原号码不会自动变成你的发送号码；请联系管理员核对绑定。
        </p>
      ) : (
        <>
          <Field label="发送号码 / 会话">
            <select
              value={selected.id}
              onChange={(e) => {
                setChosen(e.target.value);
                setTemplate("");
                setParameters([]);
                clearQuote();
              }}
            >
              {allowed.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayPhoneNumber} · {v.userName}
                </option>
              ))}
            </select>
          </Field>
          <TemplateComposer
            key={selected.id}
            selected={selected}
            revision={revision}
            templateId={templateId}
            setTemplate={setTemplate}
            parameters={parameters}
            setParameters={setParameters}
            consent={consent}
            setConsent={setConsent}
            text={text}
            setText={setText}
            quote={quote}
            clearQuote={clearQuote}
            busy={m.busy}
            send={() =>
              void m.run(
                "/whatsapp/send",
                "POST",
                {
                  conversationId: selected.id,
                  text,
                  templateId: templateId || undefined,
                  templateParameters: parameters,
                  consentConfirmed: consent,
                  replyToId:
                    quote?.conversationId === selected.id
                      ? quote.id
                      : undefined,
                },
                () => {
                  setText("");
                  clearQuote();
                  refresh();
                  notify("消息已进入发送队列，请查看送达状态");
                },
              )
            }
          />
        </>
      )}
      <ErrorBox message={m.error} />
    </div>
  );
}
function TemplateComposer(p: {
  selected: WaConversation;
  revision: number;
  templateId: string;
  setTemplate: (v: string) => void;
  parameters: string[];
  setParameters: (v: string[]) => void;
  consent: boolean;
  setConsent: (v: boolean) => void;
  text: string;
  setText: (v: string) => void;
  quote: WaMessage | null;
  clearQuote: () => void;
  busy: boolean;
  send: () => void;
}) {
  const r = useResource<WaTemplate[]>(
      `/whatsapp/accounts/${p.selected.accountId}/templates`,
      p.revision,
    ),
    templates = (r.data || []).filter(
      (t) => t.status === "APPROVED" && t.supported,
    ),
    template = templates.find((t) => t.id === p.templateId);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        p.send();
      }}
    >
      {!p.selected.windowOpen && (
        <p className="wa-warning">
          已超过24小时自由回复窗口，只能发送已审核模板。请先在“我的WhatsApp”同步模板；普通消息不会被放行。
        </p>
      )}
      <ErrorBox message={r.error} />
      <Field label="消息模板">
        <select
          value={p.templateId}
          onChange={(e) => {
            p.setTemplate(e.target.value);
            const t = templates.find((v) => v.id === e.target.value);
            p.setParameters(Array(t?.parameterCount || 0).fill(""));
          }}
        >
          <option value="">
            {p.selected.windowOpen ? "自由文本回复" : "请选择已审核模板"}
          </option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.language}
            </option>
          ))}
        </select>
      </Field>
      {template ? (
        <>
          <p className="muted">
            {template.components
              .filter((c) => c.type === "BODY")
              .map((c) => String(c.text || ""))
              .join(" ")}
          </p>
          {p.parameters.map((value, i) => (
            <Field key={i} label={`模板参数 ${i + 1}`}>
              <input
                required
                value={value}
                onChange={(e) =>
                  p.setParameters(
                    p.parameters.map((v, j) => (j === i ? e.target.value : v)),
                  )
                }
              />
            </Field>
          ))}
          <label className="wa-check">
            <input
              type="checkbox"
              checked={p.consent}
              onChange={(e) => p.setConsent(e.target.checked)}
              required
            />
            我确认客户同意接收此类消息，并已核对模板内容及Meta可能产生的费用。
          </label>
        </>
      ) : (
        <Field label="回复内容">
          <textarea
            required
            disabled={!p.selected.windowOpen}
            value={p.text}
            onChange={(e) => p.setText(e.target.value)}
            maxLength={4096}
            placeholder="由你确认后发送，不会自动回复客户。"
          />
        </Field>
      )}
      {p.quote && (
        <blockquote>
          引用：{p.quote.textContent || p.quote.messageType}{" "}
          <button type="button" onClick={p.clearQuote}>
            取消引用
          </button>
        </blockquote>
      )}
      <button
        className="primary"
        disabled={p.busy || (!p.selected.windowOpen && !template)}
      >
        {p.busy ? "保存中…" : "确认发送WhatsApp"}
      </button>
    </form>
  );
}
