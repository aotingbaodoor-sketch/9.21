import { useEffect, useRef, useState } from "react";
let csrf = "";
export const setCsrf = (value: string) => {
  csrf = value;
};
export class ApiError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export async function api<T>(
  url: string,
  method = "GET",
  body?: unknown,
  key?: string,
): Promise<T> {
  const response = await fetch(`/api${url}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET"
        ? {
            "X-CSRF-Token": csrf,
            "Idempotency-Key": key || crypto.randomUUID(),
          }
        : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== "/auth/login")
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(response.status, data.error || "请求失败", data.details);
  }
  return data;
}
export function useResource<T>(url: string, revision = 0, pollMs = 0) {
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    error: string;
    loading: boolean;
  }>({ key: "", data: null, error: "", loading: true });
  const key = `${url}:${revision}`;
  useEffect(() => {
    let live = true;
    let sequence = 0;
    const read = () => {
      const requestId = ++sequence;
      return api<T>(url)
        .then((data) => {
          if (live && requestId === sequence)
            setState({ key, data, error: "", loading: false });
        })
        .catch((error) => {
          if (live && requestId === sequence)
            setState({ key, data: null, error: error.message, loading: false });
        });
    };
    void read();
    const interval = pollMs
      ? setInterval(() => {
          if (document.visibilityState === "visible") void read();
        }, pollMs)
      : undefined;
    return () => {
      live = false;
      if (interval) clearInterval(interval);
    };
  }, [url, key, pollMs]);
  return state.key === key ? state : { data: null, error: "", loading: true };
}
export function useMutation() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    lock = useRef(false),
    retry = useRef({ signature: "", key: "" });
  async function run<T>(
    url: string,
    method: string,
    body: unknown,
    done: (value: T) => void,
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const signature = url + method + JSON.stringify(body);
    if (retry.current.signature !== signature)
      retry.current = { signature, key: crypto.randomUUID() };
    try {
      const result = await api<T>(url, method, body, retry.current.key);
      retry.current = { signature: "", key: "" };
      done(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络连接失败");
      return e;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}
export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
