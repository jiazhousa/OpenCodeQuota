import type { QuotaSnapshot, Window } from "../core/contracts.ts";
import { record } from "./credentials.ts";
import { nonnegative, schemaError, timestamp } from "./http.ts";

const PLANS: Record<string, string> = { free: "Free", plus: "Plus", pro: "Pro", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };
export function parseOpenai(data: unknown, fetchedAt: number): QuotaSnapshot {
  if (!record(data) || !record(data.rate_limit)) return schemaError();
  const windows: Window[] = [];
  for (const id of ["primary_window", "secondary_window"] as const) {
    const window = data.rate_limit[id];
    if (window === undefined || window === null) continue;
    if (!record(window)) return schemaError();
    const seconds = nonnegative(window.limit_window_seconds);
    const kind = seconds === 18000 ? "5h" : seconds === 604800 ? "week" : "unknown";
    let resetAt = timestamp(window.reset_at, 1000);
    if (resetAt === null) {
      const after = nonnegative(window.reset_after_seconds);
      if (after !== null) resetAt = timestamp(fetchedAt + after * 1000);
    }
    windows.push({ id, label: kind === "5h" ? "5 小时" : kind === "week" ? "周额度" : "未知窗口", kind, usedPercent: nonnegative(window.used_percent), resetAt });
  }
  const plan = typeof data.plan_type === "string" && Object.hasOwn(PLANS, data.plan_type) ? PLANS[data.plan_type]! : null;
  return { providerId: "openai", windows, balances: [], plan, available: null, fetchedAt };
}
