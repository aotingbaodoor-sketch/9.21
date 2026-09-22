import { HttpError } from "../domain.ts";
import { providerError, type WaConfig } from "./security.ts";
export type PhoneInfo = {
  id: string;
  display_phone_number: string;
  verified_name?: string;
  country_code?: string;
};
export interface GraphApi {
  request<T>(
    path: string,
    token: string,
    method?: string,
    body?: unknown,
  ): Promise<T>;
  exchangeCode(code: string): Promise<string>;
  media(
    id: string,
    phoneId: string,
    token: string,
  ): Promise<{ bytes: Buffer; mime: string }>;
}
export class MetaError extends HttpError {
  constructor(
    public code: string,
    public uncertain = false,
  ) {
    super(502, providerError(code));
  }
}
export function graphApi(config: WaConfig): GraphApi {
  const base = () => {
    if (!/^v\d+\.\d+$/.test(config.graphVersion))
      throw new HttpError(503, "请在服务端配置受支持的Meta Graph API版本");
    return `https://graph.facebook.com/${config.graphVersion}/`;
  };
  async function request<T>(
    path: string,
    token: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    if (!token) throw new HttpError(503, "WhatsApp凭据未配置");
    if (path.startsWith("/") || path.includes("://"))
      throw new Error("Invalid Graph path");
    let response: Response;
    try {
      response = await fetch(base() + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
    } catch {
      throw new MetaError("UNKNOWN", true);
    }
    const data = (await response.json().catch(() => null)) as {
      error?: { code?: number };
    } | null;
    if (!response.ok || data?.error)
      throw new MetaError(
        response.status === 429
          ? "429"
          : String(data?.error?.code || response.status),
        response.status >= 500,
      );
    return data as T;
  }
  return {
    request,
    async exchangeCode(code) {
      const params = new URLSearchParams({
        client_id: config.appId,
        client_secret: config.appSecret,
        code,
      });
      // OAuth凭据仅发往Meta官方服务端，不记录URL或响应中的token。
      let response: Response;
      try {
        response = await fetch(base() + "oauth/access_token?" + params, {
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
      } catch {
        throw new HttpError(502, "Meta授权交换暂时失败，请重新授权");
      }
      const data = (await response.json()) as { access_token?: string };
      if (!response.ok || !data.access_token)
        throw new HttpError(400, "Meta授权码失效或应用配置不匹配，请重新授权");
      return data.access_token;
    },
    async media(id, phoneId, token) {
      const meta = await request<{
        url: string;
        mime_type: string;
        file_size: number;
      }>(
        `${encodeURIComponent(id)}?phone_number_id=${encodeURIComponent(phoneId)}`,
        token,
      );
      const url = new URL(meta.url);
      if (
        url.protocol !== "https:" ||
        !(
          url.hostname === "lookaside.fbsbx.com" ||
          url.hostname.endsWith(".fbcdn.net") ||
          url.hostname.endsWith(".fbsbx.com")
        )
      )
        throw new HttpError(502, "媒体下载地址不在Meta允许域名内");
      const max = 25 * 1024 * 1024;
      if (meta.file_size > max)
        throw new HttpError(413, "媒体超过25MB，本版不自动下载");
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(25000),
        redirect: "error",
      });
      if (!response.ok || !response.body)
        throw new HttpError(502, "媒体下载失败，请稍后重试");
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > max) throw new HttpError(413, "媒体超过25MB");
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel();
      }
      return { bytes: Buffer.concat(chunks), mime: meta.mime_type };
    },
  };
}
