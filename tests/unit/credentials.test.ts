import { describe, expect, test } from "bun:test";
import type { HostProviders, ProviderId } from "../../src/core/contracts.ts";
import { resolveCredential } from "../../src/providers/credentials.ts";

const secret = "synthetic-secret-sentinel";
function host(id: ProviderId = "deepseek", patch: Record<string, unknown> = {}): HostProviders {
  return [{
    id, name: id, activation: "enabled",
    settings: { apiKey: secret, baseURL: id === "deepseek" ? "https://api.deepseek.com" : id === "openai" ? "https://api.openai.com" : "https://open.bigmodel.cn" },
    ...patch,
  }];
}
const result = (patch: Record<string, unknown> = {}) => resolveCredential("deepseek", host("deepseek", { settings: { apiKey: secret, baseURL: "https://api.deepseek.com", ...patch } }));

describe("凭据核心（V2 精简版）", () => {
  test("settings.apiKey 为唯一事实源：非法/null/dummy 一律拒绝，不回退", () => {
    expect(result()).toHaveProperty("credential.secret", secret);
    for (const apiKey of [null, "", "dummy", "opencode-oauth-dummy-key", 123]) {
      expect(result({ apiKey })).toHaveProperty("error.code", "credentials_unavailable");
    }
  });

  test("activation 非 enabled 视为未连接", () => {
    expect(resolveCredential("deepseek", host("deepseek", { activation: "disabled" }))).toEqual({ connected: false });
    expect(resolveCredential("deepseek", [{ id: "deepseek", name: "DeepSeek" }])).toEqual({ connected: false });
    expect(resolveCredential("deepseek", [])).toEqual({ connected: false });
  });

  test("baseURL 仅接受官方域名，自定义端点拒绝", () => {
    for (const baseURL of ["https://evil.example.com", "https://api.deepseek.com.evil.com", "http://api.deepseek.com", "https://user@api.deepseek.com"]) {
      expect(result({ baseURL })).toHaveProperty("error.code", "unsupported_endpoint");
    }
    expect(result({ baseURL: "https://api.deepseek.com/v1" })).toHaveProperty("credential.secret", secret);
  });

  test("openai 降级：V2 OAuth 链未补齐前返回明确错误", () => {
    expect(resolveCredential("openai", host("openai"))).toHaveProperty("error.code", "unsupported_auth");
  });
});
