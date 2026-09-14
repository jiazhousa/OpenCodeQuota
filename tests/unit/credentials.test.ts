import { describe, expect, test } from "bun:test";
import type { HostProviders, ProviderId } from "../../src/core/contracts.ts";
import { readCredentialsAuth, resolveCredential } from "../../src/providers/credentials.ts";
import type { AuthState } from "../../src/providers/credentials.ts";

const secret = "synthetic-secret-sentinel";
const now = 1800000000000;
const signal = new AbortController().signal;
const empty: AuthState = { ok: true, entries: {} };
function host(id: ProviderId = "deepseek", patch: Record<string, unknown> = {}): HostProviders {
  return { all: [{ id, name: id, source: "config", key: "old-key", env: [], models: {}, options: { apiKey: secret, baseURL: id === "deepseek" ? "https://api.deepseek.com" : id === "openai" ? "https://api.openai.com" : "https://open.bigmodel.cn" }, ...patch }], connected: [id], default: {} } as HostProviders;
}
const result = (patch: Record<string, unknown>, auth: AuthState = empty) => resolveCredential("deepseek", host("deepseek", patch), auth, now);
const model = (url: unknown) => ({ api: { url }, options: {}, headers: {} });

describe("凭据核心（精简版）", () => {
  test("宿主有效 apiKey 优先且非法/null/dummy 不回退旧 key", () => {
    expect(result({})).toHaveProperty("credential.secret", secret);
    for (const apiKey of [null, "", "dummy", "opencode-oauth-dummy-key", 123]) {
      expect(result({ options: { apiKey, baseURL: "https://api.deepseek.com" } })).toHaveProperty("error.code", "credentials_unavailable");
    }
    // env 来源且无 auth 条目时使用宿主返回 key，不静默兜底环境变量。
    expect(result({ source: "env", key: secret, options: { baseURL: "https://api.deepseek.com" } })).toHaveProperty("credential.secret", secret);
  });

  test("OpenAI OAuth 只读：auth 输入不保留 refresh，原生 custom+dummy 不阻断有效 OAuth", async () => {
    const state = await readCredentialsAuth({ OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: "oauth", access: secret, expires: now + 10000, accountId: "account-sentinel", refresh: "never-retain-refresh" } }) }, async () => { throw "never"; }, signal);
    expect(state).toHaveProperty("entries.openai.access", secret);
    expect(JSON.stringify(state)).not.toContain("refresh");
    const oauth: AuthState = { ok: true, entries: { openai: { type: "oauth", access: secret, expires: now + 10000, accountId: "account-sentinel" } } };
    // 原生 OAuth-only 的 source=custom 与完整 dummy 占位仍可查询。
    expect(resolveCredential("openai", host("openai", { source: "custom", options: { apiKey: "opencode-oauth-dummy-key" }, models: { a: model("") } }), oauth, now)).toHaveProperty("credential.secret", secret);
  });

  test("OAuth 过期不请求：解析直接失败，不产生可发请求的凭据", () => {
    const expired: AuthState = { ok: true, entries: { openai: { type: "oauth", access: secret, expires: now, accountId: "account-sentinel" } } };
    expect(resolveCredential("openai", host("openai", { source: "custom", options: { apiKey: "opencode-oauth-dummy-key" }, models: { a: model("") } }), expired, now)).toHaveProperty("error.code", "auth_expired");
  });
});
