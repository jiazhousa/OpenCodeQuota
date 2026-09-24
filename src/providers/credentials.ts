import { createHash } from "node:crypto";
import type { CredentialBundle, ProviderId, ResolvedCredential, SafeError } from "../core/contracts.ts";

// 私密数据只在凭据解析和请求链内使用，不进入视图或持久缓存。
export interface Credential {
  providerId: ProviderId;
  authKind: "api" | "oauth";
  secret: string;
  accountId?: string;
  expires?: number;
  identityHash: string;
}
export type CredentialResult =
  | { connected: false }
  | { connected: true; error: SafeError }
  | { connected: true; credential: Credential };
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value);
const keyValid = (value: unknown): value is string => bounded(value, 16384) && !/^(dummy|opencode-oauth-dummy-key|undefined|null)$/i.test(value);

// V2（2.0.16）凭据双源（实证 2026-09-24，docs/compatibility.md）：
//   ① db 凭据（/connect 登录）→ 插件经 ctx.integration.connection.active/resolve 读取——三渠道全支持（含 OAuth）
//   ② config 内联 → provider.list 的 settings 回显（integration.active 不覆盖此路径）
function officialUrl(value: unknown, id: ProviderId, allowEmpty = false): boolean {
  if (allowEmpty && (value === "" || value === undefined)) return true;
  if (typeof value !== "string" || !value || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    // OpenAI 在 V2（2.0.16）的内置官方端点为 chatgpt.com/backend-api/codex（transport websocket）；api.openai.com 为传统 API 端点。
    const host = id === "openai"
      ? url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex") || url.hostname === "api.openai.com"
      : id === "deepseek" ? url.hostname === "api.deepseek.com"
      : url.hostname === "open.bigmodel.cn";
    return url.protocol === "https:" && host && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

function authenticationMatches(headers: Record<string, unknown>, secret: string): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization" && value !== secret && value !== `Bearer ${secret}`) return false;
  }
  return true;
}

function fromCredential(credential: ResolvedCredential, providerId: ProviderId): Credential {
  const identityHash = createHash("sha256")
    .update(JSON.stringify([providerId, credential.kind, credential.secret, credential.accountId ?? ""]))
    .digest("hex");
  return {
    providerId,
    authKind: credential.kind,
    secret: credential.secret,
    accountId: credential.accountId,
    expires: credential.expires,
    identityHash,
  };
}

export function resolveCredential(
  providerId: ProviderId,
  bundle: CredentialBundle,
  now: number,
): CredentialResult {
  const provider = Array.isArray(bundle?.list?.data) ? bundle.list.data.find((item) => item?.id === providerId) : undefined;
  // activation=disabled 视为宿主未连接；enabled/auto 均可（auto=models.dev 目录激活）。
  if (!provider || provider.activation === "disabled") return { connected: false };
  const fail = (code: SafeError["code"]): CredentialResult => ({ connected: true, error: { code } });

  // 凭据源①：integration resolve（db）。
  let credential = bundle.resolved?.[providerId] ?? null;
  // 凭据源②：config 内联回显（provider.list settings）。
  if (!credential) {
    const settings = provider.settings;
    if (record(settings) && keyValid(settings.apiKey)) credential = { kind: "api", secret: settings.apiKey };
  }
  if (!credential) return fail("credentials_unavailable");

  if (providerId === "openai" && credential.kind === "oauth") {
    if (credential.expires !== undefined && credential.expires <= now) return fail("auth_expired");
    if (!credential.accountId) return fail("account_unidentified");
  }
  const settings = record(provider.settings) ? provider.settings : {};
  if (own(settings, "baseURL") && !officialUrl(settings.baseURL, providerId)) return fail("unsupported_endpoint");
  // 显式认证头不得与生效 secret 冲突（防以旁路头绕过身份隔离）。
  if (!authenticationMatches(record(provider.headers) ? provider.headers : {}, credential.secret)) return fail("unsupported_endpoint");
  return { connected: true, credential: fromCredential(credential, providerId) };
}

export { record as _record };
