import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { HttpError, hashToken } from "../domain.ts";
export type WaConfig = {
  appId: string;
  appSecret: string;
  verifyToken: string;
  encryptionKey: string;
  graphVersion: string;
  signupConfigId: string;
  origin: string;
};
export function waConfig(
  origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173",
): WaConfig {
  return {
    appId: process.env.WHATSAPP_APP_ID || "",
    appSecret: process.env.WHATSAPP_APP_SECRET || "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
    encryptionKey: process.env.WHATSAPP_ENCRYPTION_KEY || "",
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION || "",
    signupConfigId: process.env.WHATSAPP_SIGNUP_CONFIG_ID || "",
    origin,
  };
}
export function hasKey(config: WaConfig) {
  return /^[a-f0-9]{64}$/i.test(config.encryptionKey);
}
function key(config: WaConfig) {
  if (!hasKey(config))
    throw new HttpError(503, "WhatsApp服务端加密密钥尚未配置");
  return Buffer.from(config.encryptionKey, "hex");
}
export function encrypt(value: string, config: WaConfig) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(config), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}
export function decrypt(value: string, config: WaConfig) {
  try {
    const [v, iv, tag, body] = value.split(".");
    if (v !== "v1") throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(config),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new HttpError(
      503,
      "WhatsApp凭据无法解密，请检查服务端密钥或重新连接",
    );
  }
}
export function verifySignature(
  raw: Buffer,
  signature: string | undefined,
  secret: string,
) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/i.test(signature || "")) return false;
  const wanted = createHmac("sha256", secret).update(raw).digest(),
    given = Buffer.from(signature!.slice(7), "hex");
  return timingSafeEqual(wanted, given);
}
export const equalSecret = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hashToken(a)), Buffer.from(hashToken(b)));
export function normalizeNumber(value: string) {
  const digits = value.trim().replace(/^00/, "").replace(/\D/g, "");
  return /^[1-9]\d{6,14}$/.test(digits) ? digits : "";
}
export function maskNumber(value: string) {
  const n = normalizeNumber(value);
  return n ? `***${n.slice(-4)}` : "***";
}
export function safeMessageTime(value: unknown, now = new Date()) {
  const ms = Number(value) * 1000;
  return Number.isFinite(ms) && ms > 0
    ? new Date(Math.min(ms, now.getTime()))
    : now;
}
export function windowOpen(last: Date | string | null, now = new Date()) {
  return !!last && now.getTime() - new Date(last).getTime() < 86400000;
}
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !/(token|secret|password|authorization)/i.test(k))
        .map(([k, v]) => [k, redact(v)]),
    );
  return value;
}
export function providerError(code: string) {
  return (
    {
      "190": "授权已失效，请重新连接WhatsApp",
      "10": "Meta应用权限不足，请管理员检查授权",
      "200": "号码或账号权限不足",
      "131047": "已超过24小时回复窗口，请选择已审核模板",
      "131026": "消息无法送达，请检查接收号码及WhatsApp状态",
      "132000": "模板参数数量不匹配",
      "132001": "模板不存在或语言不匹配",
      "133010": "业务号码尚未完成官方注册",
      "429": "发送频率受限，系统将稍后重试",
      UNKNOWN: "发送结果尚未确认，请核对WhatsApp后处理，系统不会盲目重发",
    }[code] ||
    `Meta处理失败（代码${/^\d+$/.test(code) ? code : "未提供"}），请管理员检查连接与模板配置`
  );
}
