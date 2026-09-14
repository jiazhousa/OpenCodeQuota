import type { QuotaSnapshot } from "../core/contracts.ts";
import { record } from "./credentials.ts";
import { schemaError } from "./http.ts";

export const validAmount = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 128 && /^-?\d+(?:\.\d+)?$/.test(value);
export const validCurrency = (value: unknown): value is string => typeof value === "string" && /^[A-Z]{3}$/.test(value);
export function parseDeepseek(data: unknown, fetchedAt: number): QuotaSnapshot {
  if (!record(data) || !Array.isArray(data.balance_infos) || data.balance_infos.length > 100 || typeof data.is_available !== "boolean") return schemaError();
  const balances = data.balance_infos.map((balance) => {
    if (!record(balance) || !validCurrency(balance.currency) || !validAmount(balance.total_balance)) return schemaError();
    return { currency: balance.currency, amount: balance.total_balance };
  });
  return { providerId: "deepseek", windows: [], balances, plan: null, available: data.is_available, fetchedAt };
}
