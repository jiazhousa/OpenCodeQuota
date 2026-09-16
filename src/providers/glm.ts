import type { QuotaSnapshot, Window } from "../core/contracts.ts";
import { record } from "./credentials.ts";
import { nonnegative, schemaError, timestamp } from "./http.ts";

// 订阅档位展示名；与 OpenAI 的 plan 规范化风格一致，未知值置 null 不展示。
const GLM_LEVELS: Record<string, string> = { lite: "Lite", pro: "Pro", max: "Max" };

export function parseGlm(data: unknown, fetchedAt: number): QuotaSnapshot {
  if (!record(data)) return schemaError();
  if (data.success === false || (data.code !== undefined && ![0, 200, "0", "200"].includes(data.code as number))) {
    if ([401, "401", 1000, "1000", 1001, "1001", 1002, "1002"].includes(data.code as number)) throw { code: "auth_error" };
    return schemaError();
  }
  if (data.success !== undefined && typeof data.success !== "boolean") return schemaError();
  if (!record(data.data) || !Array.isArray(data.data.limits) || data.data.limits.length > 100) return schemaError();
  // data.level：订阅档位（实测值如 "max"）；缺失/未知映射保持 null，不猜。
  const rawLevel = data.data.level;
  const plan = typeof rawLevel === "string" && Object.hasOwn(GLM_LEVELS, rawLevel.toLowerCase())
    ? GLM_LEVELS[rawLevel.toLowerCase()]!
    : null;
  const windows: Window[] = data.data.limits.map((limit, index) => {
    if (!record(limit) || typeof limit.type !== "string") return schemaError();
    // 新版 Coding Plan 按信用额度返回周期单位与数量，不能只凭 unit 猜成 5h/周。
    const kind = limit.type === "CREDIT_LIMIT"
      ? (limit.unit === 3 && limit.number === 5 ? "5h" : limit.unit === 6 && limit.number === 1 ? "week" : "unknown")
      : limit.type === "TOKENS_LIMIT" ? (limit.unit === 3 ? "5h" : limit.unit === 6 ? "week" : "unknown")
      : limit.type === "TIME_LIMIT" ? "mcp" : "unknown";
    const label = kind === "5h" ? "5 小时" : kind === "week" ? "周额度" : kind === "mcp" ? "MCP 额度" : "未知窗口";
    return { id: `glm-${index}`, label, kind, usedPercent: nonnegative(limit.percentage), resetAt: timestamp(limit.nextResetTime) };
  });
  return { providerId: "zhipuai-coding-plan", windows, balances: [], plan, available: null, fetchedAt };
}
