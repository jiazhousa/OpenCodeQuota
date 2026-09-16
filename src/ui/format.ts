import { SAFE_ERROR_MESSAGES } from "../core/contracts.ts";
import type { ChannelPhase, ProviderId, SafeError } from "../core/contracts.ts";

// 用户指定渠道别名；GLM 词间为两个空格，providerID 本身不变。
export const CHANNEL_NAMES: Record<ProviderId, string> = { "zhipuai-coding-plan": "GLM Coding Plan", openai: "GPT Pro20x", deepseek: "DeepSeek" };
export const CHANNEL_PHASES: Record<ChannelPhase, string> = {
  disconnected: "Not connected", loading: "Loading", ready: "Updated", cached: "Cached", stale: "Stale", error: "Unavailable", unsupported: "Unsupported",
};
export const REFRESHING_TEXT = "Refreshing";
export const errorText = (error?: SafeError): string => error ? SAFE_ERROR_MESSAGES[error.code] : "";

export function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) || value < 0 ? "—" : `${Number(value.toFixed(1))}%`;
}
