import { describe, expect, test } from "bun:test";
import type { CredentialBundle, ProviderId } from "../../src/core/contracts.ts";
import { resolveCredential } from "../../src/providers/credentials.ts";

// V2 凭据双源（2.0.16 实证）：① integration.connection.resolve（db，/connect 登录）② provider.list settings 内联回显。
// OpenAI OAuth 走源①（access/expires/accountId）；GLM/DeepSeek 两源皆可。
const secret = "synthetic-secret-sentinel";
const oauthAccess = "synthetic-oauth-access-token-sentinel";
const now = 1800000000000;
function bundle(id: ProviderId = "deepseek", settings: Record<string, unknown> = {}, resolved: CredentialBundle["resolved"][ProviderId] = null): CredentialBundle {
  const baseURL = id === "deepseek" ? "https://api.deepseek.com" : id === "openai" ? "https://api.openai.com" : "https://open.bigmodel.cn";
  return {
    list: { location: { directory: "/tmp/synthetic" }, data: [{ id, integrationID: id, name: id, activation: "enabled", settings: { apiKey: secret, baseURL, ...settings } }] },
    resolved: { "zhipuai-coding-plan": null, openai: null, deepseek: null, ...(resolved ? { [id]: resolved } as Partial<CredentialBundle["resolved"]> : {}) } as CredentialBundle["resolved"],
  };
}
const result = (settings: Record<string, unknown> = {}, resolved: CredentialBundle["resolved"][ProviderId] = undefined as never) =>
  resolveCredential("deepseek", bundle("deepseek", settings, resolved ?? null), now);

describe("凭据核心（V2 双源）", () => {
  test("源② config 内联 apiKey 生效；非法/null/dummy 拒绝且不回退", () => {
    expect(result()).toHaveProperty("credential.secret", secret);
    expect(result()).toHaveProperty("credential.authKind", "api");
    for (const apiKey of [null, "", "dummy", "opencode-oauth-dummy-key", 123, undefined]) {
      expect(result({ apiKey })).toHaveProperty("error.code", "credentials_unavailable");
    }
  });

  test("源① integration resolve 优先于内联回显；oauth 过期/缺 accountId 拒绝", () => {
    expect(result({}, { kind: "api", secret: "integration-key-sentinel" })).toHaveProperty("credential.secret", "integration-key-sentinel");
    const oauthBundle = bundle("openai", { apiKey: undefined }, { kind: "oauth", secret: oauthAccess, expires: now + 10000, accountId: "account-sentinel" });
    expect(resolveCredential("openai", oauthBundle, now)).toHaveProperty("credential.authKind", "oauth");
    expect(resolveCredential("openai", bundle("openai", {}, { kind: "oauth", secret: oauthAccess, expires: now, accountId: "account-sentinel" }), now)).toHaveProperty("error.code", "auth_expired");
    expect(resolveCredential("openai", bundle("openai", {}, { kind: "oauth", secret: oauthAccess, expires: now + 10000 }), now)).toHaveProperty("error.code", "account_unidentified");
    // OpenAI 无任何源时如实报不可用，不冒充未连接（bundle 默认内联 apiKey 需显式清除）。
    expect(resolveCredential("openai", bundle("openai", { apiKey: undefined }), now)).toEqual({ connected: true, error: { code: "credentials_unavailable" } });
  });

  test("activation=disabled/缺席视为未连接；端点白名单与认证头一致性保持", () => {
    const disabled = bundle("deepseek");
    disabled.list.data[0]!.activation = "disabled";
    expect(resolveCredential("deepseek", disabled, now)).toEqual({ connected: false });
    expect(resolveCredential("deepseek", { list: { data: [{ id: "other", activation: "enabled" }] }, resolved: { "zhipuai-coding-plan": null, openai: null, deepseek: null } }, now)).toEqual({ connected: false });
    expect(result({ baseURL: "https://evil.example.com" })).toHaveProperty("error.code", "unsupported_endpoint");
    const withHeaders = bundle("deepseek");
    (withHeaders.list.data[0] as unknown as Record<string, unknown>).headers = { Authorization: "Bearer wrong" };
    expect(resolveCredential("deepseek", withHeaders, now)).toHaveProperty("error.code", "unsupported_endpoint");
  });
});
