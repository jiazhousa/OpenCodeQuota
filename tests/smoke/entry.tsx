/** @jsxImportSource @opentui/solid */
import { appendFileSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Fetch } from "../../src/core/contracts.ts";
import { createQuotaPlugin } from "../../src/tui.tsx";

// 仅测试入口可注入远端响应；生产组件、controller、宿主读取与 Worker 不替换。
function audit(kind: "glm" | "openai" | "deepseek" | "rejected"): void {
  const home = process.env.HOME ?? "";
  const root = home.endsWith("/home") ? home.slice(0, -5) : "";
  if (!/^\/tmp\/opencode\/channel-quota-smoke-[\w-]+$/.test(root)
    || realpathSync(root) !== root || lstatSync(root).uid !== process.getuid?.()
    || process.env.OPENCODE_TEST_HOME !== home || process.env.XDG_STATE_HOME !== join(root, "state")) {
    throw new Error("smoke 隔离环境不匹配");
  }
  // 不写 URL、headers、响应原文或账号标识；只记录静态请求类别。
  appendFileSync(join(root, "requests.ndjson"), JSON.stringify({ kind, method: kind === "rejected" ? "REJECTED" : "GET", at: Date.now() }) + "\n", { mode: 0o600 });
}

const mockFetch: Fetch = async (input, init) => {
  const request = new Request(input, init);
  const now = Date.now();
  let kind: "glm" | "openai" | "deepseek" | "rejected" = "rejected";
  let body: unknown;
  if (request.method === "GET" && request.body === null) {
    if (request.url === "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
      && request.headers.get("authorization") === "synthetic-quota-glm-secret") {
      kind = "glm";
      body = { success: true, code: 200, data: { limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 23, nextResetTime: now + 3600000 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 45, nextResetTime: now + 86400000 },
      ] } };
    } else if (request.url === "https://chatgpt.com/backend-api/wham/usage"
      && request.headers.get("authorization") === "Bearer synthetic-quota-openai-access"
      && request.headers.get("chatgpt-account-id") === "synthetic-quota-account-id") {
      kind = "openai";
      body = { plan_type: "plus", rate_limit: {
        primary_window: { limit_window_seconds: 18000, used_percent: 12, reset_after_seconds: 3600 },
        secondary_window: { limit_window_seconds: 604800, used_percent: 34, reset_after_seconds: 86400 },
      } };
    } else if (request.url === "https://api.deepseek.com/user/balance"
      && request.headers.get("authorization") === "Bearer synthetic-quota-deepseek-secret") {
      kind = "deepseek";
      body = { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "125.750000" }] };
    }
  }
  audit(kind);
  if (kind === "rejected") throw new Error("smoke 请求不符合允许的 GET/认证契约");
  if (request.signal.aborted) throw new Error("smoke 请求已中止");
  return Response.json(body);
};

export default createQuotaPlugin({ fetch: mockFetch });
