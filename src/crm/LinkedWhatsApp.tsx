import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { Panel, ErrorBox, Loading } from "./ui.tsx";
type View = {
  configured: boolean;
  status: string;
  phone: string | null;
  error: string | null;
  qr: string | null;
  expiresAt: string | null;
};
const labels: Record<string, string> = {
  disconnected: "未连接",
  connecting: "正在连接",
  qr: "等待手机扫码",
  connected: "设备已连接（真实收发待验收）",
  reconnecting: "断线重连中",
  expired: "设备授权已失效",
  error: "连接异常",
  logging_out: "正在退出",
  worker_offline: "后台连接服务暂不可用",
};
export function LinkedWhatsApp() {
  const { revision, refresh } = useSession();
  const r = useResource<View>("/whatsapp/linked", revision, 2500),
    m = useMutation();
  const [confirmed, setConfirmed] = useState(false);
  const action = (value: string) =>
    m.run(
      "/whatsapp/linked",
      "POST",
      { action: value, testAccountConfirmed: confirmed },
      () => refresh(),
    );
  return (
    <Panel title="我的 WhatsApp · 扫码关联设备">
      <p className="wa-warning">
        非官方接入（Baileys）：可能断线或导致 WhatsApp
        限制账号。请先用测试账号，不要绑定重要业务号码。不需要 Facebook 或 Meta
        开发者账号。
      </p>
      <ErrorBox message={r.error || m.error || r.data?.error || ""} />
      {r.loading ? (
        <Loading />
      ) : (
        r.data && (
          <>
            <p>
              连接状态：{labels[r.data.status] || r.data.status}　{r.data.phone}
            </p>
            {!r.data.configured && (
              <p className="wa-warning">
                部署尚缺服务端加密密钥，暂不能生成二维码。请勿提交 WhatsApp
                密码。
              </p>
            )}
            <label className="wa-check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              我使用测试账号，并已了解非官方接入风险。
            </label>
            <div className="actions">
              <button
                className="primary"
                disabled={
                  m.busy ||
                  !confirmed ||
                  !r.data.configured ||
                  r.data.status === "connected"
                }
                onClick={() => void action("connect")}
              >
                连接 WhatsApp
              </button>
              <button
                disabled={m.busy || !confirmed || !r.data.configured}
                onClick={() => void action("reconnect")}
              >
                重新连接 / 刷新二维码
              </button>
              <button
                disabled={
                  m.busy ||
                  !r.data.configured ||
                  r.data.status === "disconnected"
                }
                onClick={() => {
                  if (
                    window.confirm(
                      "退出此 CRM 的关联设备？客户与聊天记录会保留。",
                    )
                  )
                    void action("logout");
                }}
              >
                退出连接
              </button>
            </div>
            {r.data.qr && (
              <div>
                <img
                  src={r.data.qr}
                  width="320"
                  height="320"
                  style={{ maxWidth: "100%", height: "auto" }}
                  alt="仅限本人手机扫描的 WhatsApp 关联设备二维码"
                />
                <p>
                  手机 WhatsApp → 设置（或右上角菜单）→ 已关联设备 →
                  关联设备，扫描此码。不要分享二维码或截图。
                </p>
              </div>
            )}
            {r.data.status === "qr" && !r.data.qr && (
              <p>二维码已过期，等待自动更新，或点击“重新连接”。</p>
            )}
            <p>
              本阶段接收连接后的私聊新消息、自动关联客户并手动回复文字。不导入全部历史聊天；图片、文件、群聊暂未支持。扫码成功后仍需双向真实消息测试。
            </p>
            <Link to="/whatsapp">打开 WhatsApp 收件箱 →</Link>
          </>
        )
      )}
    </Panel>
  );
}
