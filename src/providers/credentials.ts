import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PROVIDER_IDS } from "../core/contracts.ts";
import type { Env, HostProviders, ProviderId, ReadAuth, SafeError } from "../core/contracts.ts";

// 私密数据只在凭据解析和请求链内使用，不进入视图或持久缓存。
export interface Credential {
  providerId: ProviderId;
  authKind: "api" | "oauth";
  secret: string;
  accountId?: string;
  expires?: number;
  identityHash: string;
}
type AuthEntry = { type: string; key?: string; access?: string; expires?: number; accountId?: string };
export type AuthState = { ok: true; entries: Partial<Record<ProviderId, AuthEntry>> } | { ok: false; error: SafeError };
export type CredentialResult =
  | { connected: false }
  | { connected: true; error: SafeError }
  | { connected: true; credential: Credential };
const MAX_AUTH = 1024 * 1024;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value);
const keyValid = (value: unknown): value is string => bounded(value, 16384) && !/^(dummy|opencode-oauth-dummy-key|undefined|null)$/i.test(value);

export const readAuthFile: ReadAuth = async (path, signal) => {
  let file;
  try {
    if (signal.aborted) throw { code: "aborted" };
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_AUTH) throw { code: "credentials_unavailable" };
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      if (signal.aborted) throw { code: "aborted" };
      const buffer = Buffer.alloc(Math.min(16384, MAX_AUTH + 1 - size));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_AUTH) throw { code: "credentials_unavailable" };
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return null;
    throw { code: signal.aborted ? "aborted" : "credentials_unavailable" } satisfies SafeError;
  } finally {
    await file?.close().catch(() => {});
  }
};

export async function readCredentialsAuth(env: Env, readAuth: ReadAuth, signal: AbortSignal): Promise<AuthState> {
  try {
    let text: string | null;
    if (own(env, "OPENCODE_AUTH_CONTENT")) {
      if (typeof env.OPENCODE_AUTH_CONTENT !== "string") throw null;
      text = env.OPENCODE_AUTH_CONTENT;
    } else {
      const base = env.XDG_DATA_HOME;
      if (base !== undefined && (!base || !isAbsolute(base))) throw null;
      text = await readAuth(join(base ?? join(homedir(), ".local/share"), "opencode/auth.json"), signal);
    }
    if (signal.aborted) return { ok: false, error: { code: "aborted" } };
    if (text === null) return { ok: true, entries: {} };
    if (Buffer.byteLength(text) > MAX_AUTH) throw null;
    const raw: unknown = JSON.parse(text);
    if (!record(raw)) throw null;
    const entries: Partial<Record<ProviderId, AuthEntry>> = {};
    for (const id of PROVIDER_IDS) {
      const entry = raw[id];
      if (entry === undefined) continue;
      if (!record(entry) || typeof entry.type !== "string") throw null;
      // 特意不提取 refresh，也不读取国际 GLM 条目。
      entries[id] = {
        type: entry.type,
        key: keyValid(entry.key) ? entry.key : undefined,
        access: keyValid(entry.access) ? entry.access : undefined,
        expires: typeof entry.expires === "number" && Number.isFinite(entry.expires) ? entry.expires : undefined,
        accountId: bounded(entry.accountId, 256) ? entry.accountId : undefined,
      };
    }
    return { ok: true, entries };
  } catch {
    return { ok: false, error: { code: signal.aborted ? "aborted" : "credentials_unavailable" } };
  }
}

function jwtAccount(access: string): string | undefined {
  try {
    const parts = access.split(".");
    if (parts.length !== 3 || !parts[1] || parts[1].length > 12000) return;
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!record(claims)) return;
    const auth = claims["https://api.openai.com/auth"];
    const id = record(auth) ? auth.chatgpt_account_id : claims.chatgpt_account_id;
    return bounded(id, 256) ? id : undefined;
  } catch { return; }
}

function officialUrl(value: unknown, id: ProviderId, allowEmpty = false): boolean {
  if (allowEmpty && (value === "" || value === undefined)) return true;
  if (typeof value !== "string" || !value || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    const domain = id === "openai" ? "api.openai.com" : id === "deepseek" ? "api.deepseek.com" : "open.bigmodel.cn";
    return url.protocol === "https:" && url.hostname === domain && !url.username && !url.password && !url.port;
  } catch { return false; }
}

function authenticationMatches(options: Record<string, unknown>, headers: Record<string, unknown>, secret: string): boolean {
  if (own(options, "apiKey") && options.apiKey !== secret) return false;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization" && value !== secret && value !== `Bearer ${secret}`) return false;
  }
  if (own(options, "headers")) {
    if (!record(options.headers)) return false;
    for (const [name, value] of Object.entries(options.headers)) {
      if (name.toLowerCase() === "authorization" && value !== secret && value !== `Bearer ${secret}`) return false;
    }
  }
  return true;
}

export function resolveCredential(
  providerId: ProviderId, providers: HostProviders, auth: AuthState, now: number, previouslyHadApiAuth = false,
): CredentialResult {
  const provider = providers.all.find((item) => item.id === providerId);
  if (!providers.connected.includes(providerId) || !provider) return { connected: false };
  const fail = (code: SafeError["code"]): CredentialResult => ({ connected: true, error: { code } });
  // 原生 OpenAI OAuth-only 也标记 custom；来源不能替代后续 OAuth、端点和模型认证校验。
  if (!["api", "config", "env", "custom"].includes(provider.source) ||
      (provider.source === "custom" && providerId !== "openai")) return fail("unsupported_provider");
  const options = provider.options;
  if (!record(options) || !record(provider.models)) return fail("unsupported_endpoint");
  let secret: string;
  let accountId: string | undefined;
  let expires: number | undefined;
  const authKind = providerId === "openai" ? "oauth" : "api";
  if (providerId === "openai") {
    if (!auth.ok) return { connected: true, error: auth.error };
    const entry = auth.entries.openai;
    if (!entry || entry.type !== "oauth") return fail("unsupported_auth");
    if (!entry.access || entry.expires === undefined) return fail("credentials_unavailable");
    if (entry.expires <= now) return fail("auth_expired");
    secret = entry.access;
    expires = entry.expires;
    accountId = entry.accountId ?? jwtAccount(secret);
    if (!accountId) return fail("account_unidentified");
  } else {
    const candidate = own(options, "apiKey") ? options.apiKey : provider.key;
    if (!keyValid(candidate)) return fail("credentials_unavailable");
    secret = candidate;
    // 显式配置已覆盖认证文件时，不比较低优先级存储。
    if (!(provider.source === "config" && own(options, "apiKey"))) {
      if (!auth.ok) return { connected: true, error: auth.error };
      const entry = auth.entries[providerId];
      if (entry?.type === "api") {
        if (entry.key !== secret || provider.source === "env") return fail("host_restart_required");
      } else if (provider.source === "api" || previouslyHadApiAuth) return fail("host_restart_required");
      else if (entry) return fail("unsupported_auth");
    }
  }
  if (own(options, "baseURL") && !officialUrl(options.baseURL, providerId)) return fail("unsupported_endpoint");
  // OAuth 的 provider apiKey 可能是宿主 dummy；仍核查显式认证头及模型覆盖。
  if (!authenticationMatches({}, record(options.headers) ? options.headers : {}, secret) ||
      (own(options, "headers") && !record(options.headers))) return fail("unsupported_endpoint");
  let validUrls = 0;
  for (const model of Object.values(provider.models)) {
    if (!record(model) || !record(model.options) || !record(model.headers) || !record(model.api)) return fail("unsupported_endpoint");
    if (!authenticationMatches(model.options, model.headers, secret)) return fail("unsupported_endpoint");
    if (own(model.options, "baseURL") && !officialUrl(model.options.baseURL, providerId)) return fail("unsupported_endpoint");
    if (!own(options, "baseURL")) {
      if (!officialUrl(model.api.url, providerId, providerId === "openai")) return fail("unsupported_endpoint");
      if (model.api.url) validUrls++;
    }
  }
  if (!own(options, "baseURL") && providerId !== "openai" && !validUrls) return fail("unsupported_endpoint");
  const identityHash = createHash("sha256").update(JSON.stringify([providerId, authKind, secret, accountId ?? ""])).digest("hex");
  return { connected: true, credential: { providerId, authKind, secret, accountId, expires, identityHash } };
}
