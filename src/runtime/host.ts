import type { CredentialBundle, HostPort, LocalCheckResult, ProviderId, ResolvedCredential } from "../core/contracts.ts";
import { PROVIDER_IDS } from "../core/contracts.ts";

// V2 server 侧插件 ctx 的最小消费面（OpenCode 2.0.16 实证 + 官方 build/plugins 契约；手写形状，零运行时依赖插件包）。
export interface V2ServerContext {
  app: { version?: string };
  provider: { list(options?: { signal?: AbortSignal }): Promise<unknown> };
  integration: {
    connection: {
      active(integrationID: string): Promise<unknown>;
      resolve(connection: unknown): Promise<unknown>;
    };
  };
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value);
const keyValid = (value: unknown): value is string => bounded(value, 16384) && !/^(dummy|opencode-oauth-dummy-key|undefined|null)$/i.test(value);

// OAuth access 是 JWT：accountId 缺失时从 claims 恢复（V1 语义保留）。
function jwtAccount(access: string): string | undefined {
  try {
    const parts = access.split(".");
    if (parts.length !== 3 || !parts[1] || parts[1].length > 12000) return;
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!object(claims)) return;
    const auth = claims["https://api.openai.com/auth"];
    const id = object(auth) ? auth.chatgpt_account_id : claims.chatgpt_account_id;
    return bounded(id, 256) ? id : undefined;
  } catch { return; }
}

/** integration resolve 结果 → 规范化凭据（api：{type:"key", key}——2.0.16 实测字面量；oauth：{type:"oauth", access, refresh, expires, metadata}） */
function normalize(resolved: unknown): ResolvedCredential | null {
  if (!object(resolved)) return null;
  const type = resolved.type;
  if (type === "key" || type === "api") {
    return keyValid(resolved.key) ? { kind: "api", secret: resolved.key } : null;
  }
  if (type === "oauth") {
    if (!keyValid(resolved.access)) return null;
    const metadata = object(resolved.metadata) ? resolved.metadata : {};
    return {
      kind: "oauth",
      secret: resolved.access,
      expires: typeof resolved.expires === "number" && Number.isFinite(resolved.expires) ? resolved.expires : undefined,
      accountId: bounded(metadata.accountId, 256) ? metadata.accountId : jwtAccount(resolved.access),
    };
  }
  return null;
}

const isProviderList = (value: unknown): value is CredentialBundle["list"] =>
  object(value) && Array.isArray((value as CredentialBundle["list"]).data);

export function createServerHostPort(ctx: V2ServerContext): HostPort {
  let verified = false;
  return {
    async checkLocal(signal): Promise<LocalCheckResult> {
      verified = false;
      if (signal.aborted) return { ok: false, error: { code: "aborted" } };
      const version = ctx.app?.version;
      // server 侧插件运行在宿主 server 进程内（无远程概念）；版本门守 2.x（用户决策 2026-09-24）。
      if (typeof version !== "string" || !/^2\.\d+\.\d+/.test(version)) return { ok: false, error: { code: "version_unsupported" } };
      verified = true;
      return { ok: true };
    },
    async readCredentials(signal): Promise<CredentialBundle> {
      if (!verified || signal.aborted) throw { code: "host_unavailable" };
      let list: CredentialBundle["list"];
      try {
        const response: unknown = await ctx.provider.list();
        if (signal.aborted || !isProviderList(response)) throw new Error();
        list = response;
      } catch {
        // 不将 SDK 异常（可能含 URL、请求头和凭据）跨过边界。
        throw { code: "host_unavailable" };
      }
      const resolved: Record<ProviderId, ResolvedCredential | null> = { "zhipuai-coding-plan": null, openai: null, deepseek: null };
      await Promise.all(PROVIDER_IDS.map(async (id) => {
        try {
          const conn = await ctx.integration.connection.active(id);
          if (!conn) return;
          const raw = await ctx.integration.connection.resolve(conn);
          resolved[id] = normalize(raw);
        } catch {
          resolved[id] = null; // 单渠道解析失败不阻断其余渠道。
        }
      }));
      if (signal.aborted) throw { code: "aborted" };
      return { list, resolved };
    },
  };
}
