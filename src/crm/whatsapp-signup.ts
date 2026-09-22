import type { WaConfigView } from "../../shared/whatsapp.ts";
type FB = {
  init: (input: Record<string, unknown>) => void;
  login: (
    callback: (result: { authResponse?: { code?: string } }) => void,
    options: Record<string, unknown>,
  ) => void;
};
declare global {
  interface Window {
    FB?: FB;
  }
}
let sdk: Promise<void> | undefined;
export function loadMetaSdk(config: WaConfigView) {
  sdk ??= new Promise<void>((resolve, reject) => {
    if (window.FB) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      sdk = undefined;
      script.remove();
      reject(new Error("Meta官方授权脚本加载失败，请检查网络"));
    };
    document.head.append(script);
  });
  return sdk.then(() => {
    if (!window.FB) throw new Error("Meta官方授权暂不可用");
    window.FB.init({
      appId: config.appId,
      version: config.graphVersion,
      cookie: false,
      xfbml: false,
    });
  });
}
export function embeddedSignup(
  config: WaConfigView,
): Promise<{ code: string; wabaId: string; phoneNumberId: string }> {
  return new Promise((resolve, reject) => {
    if (!window.FB) {
      reject(new Error("请先准备官方授权"));
      return;
    }
    let code = "",
      wabaId = "",
      phoneNumberId = "";
    const finish = () => {
      if (code && wabaId && phoneNumberId) {
        cleanup();
        resolve({ code, wabaId, phoneNumberId });
      }
    };
    const receive = (event: MessageEvent) => {
      if (
        !["https://www.facebook.com", "https://web.facebook.com"].includes(
          event.origin,
        ) ||
        typeof event.data !== "string"
      )
        return;
      try {
        const data = JSON.parse(event.data);
        if (data.type !== "WA_EMBEDDED_SIGNUP") return;
        if (
          [
            "FINISH",
            "FINISH_ONLY_WABA",
            "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
          ].includes(data.event)
        ) {
          wabaId = String(data.data?.waba_id || "");
          phoneNumberId = String(data.data?.phone_number_id || "");
          finish();
        } else if (["CANCEL", "ERROR"].includes(data.event)) {
          cleanup();
          reject(new Error("官方授权未完成，请检查Meta提示后重试"));
        }
      } catch {
        /* 忽略不属于官方授权的页面消息。 */
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("授权超时，未绑定任何新号码，请重试"));
    }, 180000);
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
    }
    window.addEventListener("message", receive);
    window.FB.login(
      (result) => {
        code = result.authResponse?.code || "";
        if (!code) {
          cleanup();
          reject(new Error("你已取消授权，未修改已有号码"));
          return;
        }
        finish();
      },
      {
        config_id: config.signupConfigId,
        response_type: "code",
        override_default_response_type: true,
        extras: { sessionInfoVersion: 3 },
      },
    );
  });
}
