import type { Clock, Fetch, SafeError } from "../core/contracts.ts";
import type { Credential } from "./credentials.ts";
import { record } from "./credentials.ts";

export const ENDPOINTS = {
  "zhipuai-coding-plan": "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  openai: "https://chatgpt.com/backend-api/wham/usage",
  deepseek: "https://api.deepseek.com/user/balance",
} as const;
export type HttpResult = { ok: true; data: unknown; receivedAt: number } | { ok: false; error: SafeError };
export const schemaError = (): never => { throw { code: "schema_error" } satisfies SafeError; };
export function nonnegative(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return schemaError();
  return value;
}
export function timestamp(value: unknown, multiplier = 1): number | null {
  const number = nonnegative(value);
  if (number === null) return null;
  const result = number * multiplier;
  if (!Number.isFinite(result) || result > 8.64e15) return schemaError();
  return result;
}
export function parserError(error: unknown): SafeError {
  return { code: record(error) && error.code === "auth_error" ? "auth_error" : "schema_error" };
}
export function retryAfter(value: string | null, now: number): number | undefined {
  if (!value || value.length > 128) return;
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined;
  const at = seconds === undefined ? Date.parse(value) : now + seconds * 1000;
  return Number.isFinite(at) && at >= now && at <= 8.64e15 ? at : undefined;
}
export function retryable(error: SafeError): boolean {
  return error.code === "network_error" || error.code === "timeout" || error.code === "rate_limited" ||
    (error.code === "http_error" && (error.httpStatus ?? 0) >= 500);
}

export async function requestQuota(credential: Credential, fetch: Fetch, clock: Clock, signal: AbortSignal): Promise<HttpResult> {
  const controller = new AbortController();
  let timedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelRace: ((value: HttpResult) => void) | undefined;
  const canceled = new Promise<HttpResult>((resolve) => { cancelRace = resolve; });
  const abort = () => {
    controller.abort();
    void reader?.cancel().catch(() => {});
    cancelRace?.({ ok: false, error: { code: timedOut ? "timeout" : "aborted" } });
  };
  signal.addEventListener("abort", abort, { once: true });
  const timer = clock.setTimeout(() => { timedOut = true; abort(); }, 15000);
  if (signal.aborted) abort();
  const work = async (): Promise<HttpResult> => {
    try {
      if (controller.signal.aborted) return { ok: false, error: { code: "aborted" } };
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: credential.providerId === "zhipuai-coding-plan" ? credential.secret : `Bearer ${credential.secret}`,
      };
      if (credential.providerId === "openai") headers["ChatGPT-Account-Id"] = credential.accountId!;
      const response = await fetch(ENDPOINTS[credential.providerId], { method: "GET", headers, redirect: "error", signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); return { ok: false, error: { code: timedOut ? "timeout" : "aborted" } }; }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const code = response.status === 401 || response.status === 403 ? "auth_error" : response.status === 429 ? "rate_limited" : "http_error";
        const retryAt = retryAfter(response.headers.get("retry-after"), clock.now());
        return { ok: false, error: { code, httpStatus: response.status, ...(retryAt === undefined ? {} : { retryAt }) } };
      }
      if (response.redirected) { void response.body?.cancel().catch(() => {}); return { ok: false, error: { code: "http_error" } }; }
      const length = response.headers.get("content-length");
      if (length && Number(length) > 1024 * 1024) {
        void response.body?.cancel().catch(() => {});
        return { ok: false, error: { code: "response_too_large" } };
      }
      if (!response.body) return { ok: false, error: { code: "schema_error" } };
      reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) return { ok: false, error: { code: timedOut ? "timeout" : "aborted" } };
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) {
          void reader.cancel().catch(() => {});
          controller.abort();
          return { ok: false, error: { code: "response_too_large" } };
        }
        chunks.push(value);
      }
      try {
        const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return { ok: true, data, receivedAt: clock.now() };
      } catch { return { ok: false, error: { code: "schema_error" } }; }
    } catch {
      return { ok: false, error: { code: controller.signal.aborted ? (timedOut ? "timeout" : "aborted") : "network_error" } };
    } finally { try { reader?.releaseLock(); } catch {} }
  };
  try { return await Promise.race([work(), canceled]); }
  finally { clock.clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
