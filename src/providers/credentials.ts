import { createHash } from "node:crypto";
import type { HostProviders, ProviderId, SafeError } from "../core/contracts.ts";

// 宿主 provider 条目的 settings 是凭证唯一事实源。
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

// 仅接受官方端点；自定义 baseURL 一律拒绝（凭证不得发往任意地址）。
function officialUrl(value: unknown, id: ProviderId, allowEmpty = false): boolean {
  if (allowEmpty && (value === "" || value === undefined)) return true;
  if (typeof value !== "string" || !value || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    const domain = id === "openai" ? "api.openai.com" : id === "deepseek" ? "api.deepseek.com" : "open.bigmodel.cn";
    return url.protocol === "https:" && url.hostname === domain && !url.username && !url.password && !url.port;
  } catch { return false; }
}

export function resolveCredential(providerId: ProviderId, providers: HostProviders): CredentialResult {
  const provider = providers.find((item) => item.id === providerId);
  if (!provider || provider.activation !== "enabled") return { connected: false };
  const fail = (code: SafeError["code"]): CredentialResult => ({ connected: true, error: { code } });
  // TODO(openai-oauth)：V2 凭证存于宿主数据库，OAuth token 暂无法获取，先降级为明确错误。
  if (providerId === "openai") return fail("unsupported_auth");
  const settings = provider.settings;
  if (!record(settings)) return fail("unsupported_endpoint");
  const secret = own(settings, "apiKey") ? settings.apiKey : undefined;
  if (!keyValid(secret)) return fail("credentials_unavailable");
  if (own(settings, "baseURL") && !officialUrl(settings.baseURL, providerId)) return fail("unsupported_endpoint");
  const identityHash = createHash("sha256").update(JSON.stringify([providerId, "api", secret])).digest("hex");
  return { connected: true, credential: { providerId, authKind: "api", secret, identityHash } };
}
