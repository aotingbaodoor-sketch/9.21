import type { WaSetupCheck } from "../../shared/whatsapp.ts";
import { hasKey, type WaConfig } from "./security.ts";

// Configuration presence is not proof of Meta approval, asset ownership or message delivery.
export function setupChecks(config: WaConfig): WaSetupCheck[] {
  const entries: [string, string, boolean, boolean, string][] = [
    ["https", "公网 HTTPS", config.origin.startsWith("https://"), true, "核对 Railway APP_ORIGIN 与公网域名一致"],
    ["app", "本 CRM 的 Meta App ID", /^\d+$/.test(config.appId), true, "登录 Meta，选择公司的 WhatsApp 应用，再配置 WHATSAPP_APP_ID；不是微信 App ID"],
    ["secret", "Meta App Secret", !!config.appSecret, true, "将同一个 Meta 应用的 App Secret 保存到 Railway 服务端变量，不发到聊天"],
    ["verify", "Webhook 校验令牌", !!config.verifyToken, true, "在 Railway 保存 WHATSAPP_VERIFY_TOKEN，并在 Meta Webhook 配置中使用同一个值"],
    ["key", "凭据加密密钥", hasKey(config), true, "配置独立的 32 字节加密密钥并安全备份；已有绑定时不要重新生成"],
    ["version", "Graph API 版本格式", /^v\d+\.\d+$/.test(config.graphVersion), true, "从 Meta 应用控制台核实支持中的版本，再配置 WHATSAPP_GRAPH_VERSION；格式正确不代表仍受支持"],
    ["signup", "员工 Embedded Signup 配置", /^\d+$/.test(config.signupConfigId), false, "仅员工自主授权需要；公司已有 Cloud API 号码可先由管理员绑定，不要求每位员工创建 Meta App"],
  ];
  return entries.map(([id, label, configured, required, nextStep]) => ({ id, label, configured, required, nextStep }));
}
