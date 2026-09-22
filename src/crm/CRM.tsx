import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import type { Customer, Settings, User } from "../../shared/contracts.ts";
import { api, setCsrf, useMutation } from "./api.ts";
import { SessionContext } from "./context.tsx";
import {
  CustomerForm,
  DeleteDialog,
  EditCustomerLoader,
  FollowForm,
} from "./forms.tsx";
import {
  Analytics,
  CustomerDetail,
  Customers,
  Dashboard,
  Followups,
  Notifications,
  Records,
  SettingsPage,
  Team,
} from "./pages.tsx";
import ImportPage from "./ImportPage.tsx";
import { Quotations, QuoteProject } from "./Quotations.tsx";
import { QuoteAdmin } from "./QuoteAdmin.tsx";
import { QuoteTasks } from "./QuoteTasks.tsx";
import { SupplyChain, FactoryManager } from "./SupplyChain.tsx";
const FactoryOrders = lazy(() => import("./FactoryPortal.tsx").then(module => ({default: module.FactoryOrders})));
const FactoryProducts = lazy(() => import("./FactoryPortal.tsx").then(module => ({default: module.FactoryProducts})));
import {
  MyWhatsApp,
  WhatsAppBadge,
  WhatsAppInbox,
  WhatsAppIntegration,
} from "./WhatsApp.tsx";
import { ErrorBox, Field, Loading } from "./ui.tsx";
type Auth = { user: User; settings: Settings; csrf: string };
export default function CRM() {
  return (
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  );
}
function Root() {
  const [session, setSession] = useState<Auth | null>(null),
    [loading, setLoading] = useState(true),
    [connectionError, setConnectionError] = useState(""),
    [revision, setRevision] = useState(0),
    [toast, setToast] = useState(""),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    [mobile, setMobile] = useState(false),
    [modal, setModal] = useState<{
      type: "add" | "edit" | "follow" | "delete" | "restore";
      customer?: Customer;
    } | null>(null);
  const location = useLocation(),
    navigate = useNavigate(),
    logout = useMutation();
  const reloadSession = useCallback(async () => {
    try {
      const result = await api<Auth>("/auth/me");
      setCsrf(result.csrf);
      setSession(result);
      setConnectionError("");
    } catch (error) {
      setSession(null);
      setModal(null);
      if ((error as { status?: number }).status !== 401)
        setConnectionError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- 首次与服务端会话同步；状态只在异步网络请求完成后更新。
    void reloadSession();
    const expire = () => {
      setSession(null);
      setModal(null);
      setCsrf("");
    };
    window.addEventListener("session-expired", expire);
    return () => {
      window.removeEventListener("session-expired", expire);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reloadSession]);
  const notify = (s: string) => {
    setToast(s);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(""), 4500);
  };
  const close = useCallback(() => setModal(null), []);
  const refresh = () => setRevision((v) => v + 1);
  const actions = {
    edit: (c?: Customer) => setModal({ type: c ? "edit" : "add", customer: c }),
    follow: (c: Customer) => setModal({ type: "follow", customer: c }),
    remove: (c: Customer, restore = false) =>
      setModal({ type: restore ? "restore" : "delete", customer: c }),
  };
  if (loading)
    return (
      <div className="login">
        <div className="login-card">
          <Loading />
        </div>
      </div>
    );
  if (!session)
    return (
      <Login
        error={connectionError}
        onLogin={async () => {
          await reloadSession();
          if (location.pathname === "/login")
            navigate("/dashboard", { replace: true });
        }}
      />
    );
  const { user, settings } = session,
    specialist = ["technical", "logistics", "factory", "coordinator"].includes(user.role),
    menus = [
      ["/dashboard", "工作台"],
      ["/customers", "客户管理"],
      ["/follow-ups", "今日跟进"],
      ["/records", "跟进记录"],
      ["/notifications", "提醒中心"],
      ["/whatsapp", "WhatsApp 收件箱"],
      ["/whatsapp/account", "我的 WhatsApp"],
      ...(["admin", "sales"].includes(user.role) ? [["/quotations", "报价管理"]] : []),
      ...(user.role === "admin"
        ? [["/whatsapp/integration", "WhatsApp 集成"]]
        : []),
      ...(user.role === "admin" ? [["/team", "员工管理"]] : []),
      ["/analytics", "数据统计"],
      ["/settings", "系统设置"],
      ...(user.role === "admin" ? [["/import", "旧数据导入"]] : []),
      ...(user.role === "admin" ? [["/quotations/products", "产品与价格"], ["/quotations/settings", "报价规则与汇率"]] : []),
      ...(["admin", "logistics"].includes(user.role) ? [["/quotations/freight", "海外运价库"]] : []),
      ...(user.role !== "sales" ? [["/quotations/tasks", "报价审批 / 技术任务"]] : []),
      ...(["admin", "sales", "technical", "logistics"].includes(user.role) ? [["/supply", "订单供应链"]] : []),
      ...(user.role === "factory" ? [["/factory/products", "供货产品"], ["/factory/orders", "工厂订单"]] : []),
      ...(["coordinator","technical","logistics"].includes(user.role) ? [["/supply/assigned", "我的跟单任务"]] : []),
      ...(user.role === "admin" ? [["/supply/factories", "合作工厂管理"], ["/factory/products", "工厂产品审核"]] : []),
    ].filter(([path]) => user.role === "factory" ? path.startsWith("/factory/") : user.role === "coordinator" ? path.startsWith('/supply/') : !specialist || path.startsWith("/quotations/") || path.startsWith("/supply")),
    title =
      (menus.find(([path]) => location.pathname === path) ||
        menus.find(([path]) => location.pathname.startsWith(path)))?.[1] ||
      settings.name;
  return (
    <SessionContext.Provider
      value={{ user, settings, revision, refresh, notify, reloadSession }}
    >
      <div className="app">
        <aside className={`sidebar ${mobile ? "open" : ""}`}>
          <div className="brand">
            <b>{settings.name}</b>
            <small>AUTINBERG CRM</small>
          </div>
          {menus.length > 10 && <small className="sidebar-scroll-hint">菜单可上下滚动 ↓</small>}
          <nav aria-label="主导航">
            {menus.map(([path, label]) => (
              <NavLink
                to={path}
                end={path === "/whatsapp"}
                key={path}
                onClick={() => setMobile(false)}
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <footer>
            {settings.company}
            <small>专注客户，持续跟进</small>
            {mobile && (
              <button onClick={() => setMobile(false)}>关闭菜单</button>
            )}
          </footer>
        </aside>
        <main className="main">
          <header className="topbar">
            <div>
              <h1>
                {location.pathname === "/dashboard"
                  ? `你好，${user.name}`
                  : title}
              </h1>
              <p>
                {new Date().toLocaleDateString("zh-CN", {
                  timeZone: settings.timezone,
                  dateStyle: "full",
                })}{" "}
                · {settings.timezone}
              </p>
            </div>
            <div className="actions">
              <button className="mobile-menu" onClick={() => setMobile(true)}>
                菜单
              </button>
              {!specialist && <><Link to="/customers">搜索客户</Link>
              <button className="primary" onClick={() => actions.edit()}>
                ＋ 添加客户
              </button>
              <Link to="/notifications" aria-label="提醒中心">
                提醒
              </Link>
              <WhatsAppBadge /></>}
              {user.avatar ? (
                <img className="avatar" src={user.avatar} alt={user.name} />
              ) : (
                <span className="avatar">{user.name.slice(0, 1)}</span>
              )}
              <button
                disabled={logout.busy}
                onClick={() =>
                  void logout.run("/auth/logout", "POST", {}, () => {
                    setSession(null);
                    setModal(null);
                    setCsrf("");
                    navigate("/login");
                  })
                }
              >
                退出
              </button>
            </div>
          </header>
          <ErrorBox message={logout.error} />
          <Suspense fallback={<Loading />}><Routes>
            <Route path="/quotations/products" element={<QuoteAdmin mode="products" />} />
            <Route path="/quotations/freight" element={<QuoteAdmin mode="freight" />} />
            <Route path="/quotations/settings" element={<QuoteAdmin mode="settings" />} />
            <Route path="/quotations/tasks" element={<QuoteTasks />} />
            <Route path="/supply" element={<SupplyChain />} />
            <Route path="/supply/factories" element={user.role === "admin" ? <FactoryManager /> : <ErrorBox message="仅管理员可管理合作工厂" />} />
            <Route path="/supply/assigned" element={<FactoryOrders />} />
            <Route path="/factory/products" element={<FactoryProducts />} />
            <Route path="/factory/orders" element={<FactoryOrders />} />
            <Route path="/quotations/:id" element={<QuoteProject />} />
            <Route path="/dashboard" element={user.role === "factory" ? <Navigate to="/factory/products" replace /> : user.role === 'coordinator' ? <Navigate to="/supply/assigned" replace /> : specialist ? <Navigate to="/quotations/tasks" replace /> : <Dashboard {...actions} />} />
            <Route path="/customers" element={<Customers {...actions} />} />
            <Route
              path="/customers/:id"
              element={<CustomerDetail {...actions} />}
            />
            <Route path="/follow-ups" element={<Followups {...actions} />} />
            <Route path="/records" element={<Records />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/whatsapp" element={<WhatsAppInbox />} />
            <Route path="/whatsapp/account" element={<MyWhatsApp />} />
            <Route path="/quotations" element={<Quotations />} />
            <Route
              path="/whatsapp/integration"
              element={<WhatsAppIntegration />}
            />
            <Route
              path="/team"
              element={
                user.role === "admin" ? (
                  <Team />
                ) : (
                  <ErrorBox message="无权访问员工管理" />
                )
              }
            />
            <Route
              path="/import"
              element={
                user.role === "admin" ? (
                  <ImportPage />
                ) : (
                  <ErrorBox message="仅管理员可导入数据" />
                )
              }
            />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes></Suspense>
        </main>
        {modal?.type === "add" && (
          <CustomerForm customer={null} close={close} />
        )}{" "}
        {modal?.type === "edit" && modal.customer && (
          <EditCustomerLoader id={modal.customer.id} close={close} />
        )}{" "}
        {modal?.type === "follow" && modal.customer && (
          <FollowForm customer={modal.customer} close={close} />
        )}{" "}
        {(modal?.type === "delete" || modal?.type === "restore") &&
          modal.customer && (
            <DeleteDialog
              customer={modal.customer}
              restore={modal.type === "restore"}
              close={close}
            />
          )}{" "}
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </div>
    </SessionContext.Provider>
  );
}
function Login({
  onLogin,
  error,
}: {
  onLogin: () => Promise<void>;
  error: string;
}) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    m = useMutation();
  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void m.run<{ csrf: string }>(
            "/auth/login",
            "POST",
            { email, password },
            (data) => {
              setCsrf(data.csrf);
              void onLogin();
            },
          );
        }}
      >
        <div className="brand">
          <b>奥汀堡CRM</b>
          <small>AUTINBERG CRM</small>
        </div>
        <h2>建材外贸客户管理系统</h2>
        <p>佛山奥汀堡建材公司</p>
        <Field label="邮箱">
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="密码">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <ErrorBox message={m.error || error} />
        <button className="primary" disabled={m.busy}>
          {m.busy ? "登录中…" : "登录"}
        </button>
        <p className="muted">请使用管理员为您创建的员工账号。</p>
      </form>
    </div>
  );
}
