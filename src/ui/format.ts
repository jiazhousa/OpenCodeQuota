import { SAFE_ERROR_MESSAGES } from "../core/contracts.ts";
import type { ChannelPhase, ProviderId, SafeError, SpendPhase } from "../core/contracts.ts";

// 用户指定渠道别名；GLM 词间为两个空格，providerID 本身不变。
export const CHANNEL_NAMES: Record<ProviderId, string> = { "zhipuai-coding-plan": "GLM Coding Plan", openai: "GPT Pro20x", deepseek: "DeepSeek" };
export const CHANNEL_PHASES: Record<ChannelPhase, string> = {
  disconnected: "未连接", loading: "加载中", ready: "已更新", cached: "缓存（待校准）", stale: "陈旧数据", error: "不可用", unsupported: "不支持",
};
export const SPEND_PHASES: Record<SpendPhase, string> = { loading: "统计中", ready: "已更新", partial: "部分统计", stale: "陈旧统计", error: "不可用" };
export const errorText = (error?: SafeError): string => error ? SAFE_ERROR_MESSAGES[error.code] : "";

export function formatUsd(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount) || amount < 0) return "—";
  if (amount > 0 && amount < 0.000001) return "< USD 0.000001（估算）";
  let digits = 2;
  while (amount > 0 && amount < 10 ** -digits && digits < 6) digits++;
  return `USD ${amount.toFixed(digits)}（估算）`;
}

export function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) || value < 0 ? "—" : `${Number(value.toFixed(1))}%`;
}

export function progressWidth(value: number | null): `${number}%` {
  return `${value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value))}%`;
}

export function formatReset(resetAt: number | null, now: number): string {
  if (resetAt === null || !Number.isFinite(resetAt)) return "重置时间未知";
  if (resetAt <= now) return "已到重置时间，待刷新";
  const minutes = Math.ceil((resetAt - now) / 60000);
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时 ${minutes % 60} 分钟后重置` : `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`;
}

export function formatTime(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
