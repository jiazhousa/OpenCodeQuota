import type { ProviderListResponses } from "@opencode-ai/sdk/v2/types";

export const PROVIDER_IDS = [
  "zhipuai-coding-plan",
  "openai",
  "deepseek",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

// 文案只能来自静态映射，不拼接供应商、SDK 或认证文件异常原文。
export const SAFE_ERROR_MESSAGES = {
  aborted: "Operation cancelled",
  local_unsupported: "Only the standard local TUI is supported",
  version_unsupported: "Only OpenCode 1.x is supported",
  host_unavailable: "Host state unavailable",
  credentials_unavailable: "No valid credentials; check the host connection",
  host_restart_required: "Credentials changed; restart OpenCode and retry",
  unsupported_provider: "Unsupported custom provider connection",
  unsupported_endpoint: "Unsupported custom endpoint or model auth config",
  unsupported_auth: "This auth method does not support quota queries",
  auth_expired: "Sign-in expired; reconnect via the host",
  account_unidentified: "Subscription account unidentified; reconnect via the host",
  auth_error: "Authentication failed; check the host connection",
  network_error: "Network request failed",
  timeout: "Request timed out",
  rate_limited: "Rate limited; retry after the cooldown",
  http_error: "Provider request failed",
  response_too_large: "Response exceeds the safe size limit",
  schema_error: "Unrecognized provider response format",
  internal_error: "Operation could not be completed",
} as const;

export type SafeErrorCode = keyof typeof SAFE_ERROR_MESSAGES;

export interface SafeError {
  code: SafeErrorCode;
  httpStatus?: number;
  // 所有跨模块时间戳统一使用毫秒；此处为可再次尝试的绝对时刻。
  retryAt?: number;
}

export interface Window {
  id: string;
  // 标签必须由适配器规范化，未知原始字段不得直接展示。
  label: string;
  kind: "5h" | "week" | "mcp" | "unknown";
  usedPercent: number | null;
  resetAt: number | null;
}

export interface Balance {
  currency: string;
  // 已校验的有界十进制字符串，可为负；不得先转换为浮点数。
  amount: string;
}

export interface QuotaSnapshot {
  providerId: ProviderId;
  windows: Window[];
  balances: Balance[];
  plan: string | null;
  available: boolean | null;
  fetchedAt: number;
}

export type ChannelPhase =
  | "disconnected"
  | "loading"
  | "ready"
  | "cached"
  | "stale"
  | "error"
  | "unsupported";

export interface ChannelView {
  providerId: ProviderId;
  connected: boolean;
  phase: ChannelPhase;
  snapshot?: QuotaSnapshot;
  error?: SafeError;
  refreshing: boolean;
  lastAttemptAt?: number;
}

export type LocalCheckResult =
  | { ok: true }
  | { ok: false; error: SafeError };

export type LocalStatus =
  | { phase: "checking" }
  | { phase: "ready" }
  | { phase: "unsupported" | "error"; error: SafeError };

// 这是唯一视图边界，不接纳原始 Provider 或认证对象。
export interface ViewState {
  channels: ChannelView[];
  now: number;
  localStatus: LocalStatus;
}

export type Dispose = () => void;
export type TimeoutHandle = ReturnType<typeof globalThis.setTimeout> | number;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimeoutHandle;
  clearTimeout(handle: TimeoutHandle): void;
}

// V2 provider.list 返回形态（OpenCode 2.0.16 运行时实证 2026-09-24；不引官方类型包——零运行时依赖）。
// 该原始数据仅在宿主适配与凭据服务之间流动，不能进入 ViewState。
// V2 语义：settings 回显 config 声明的内联值（含 apiKey）；db 凭据（OAuth）不经此接口暴露。
export interface V2ProviderEntry {
  id: string;
  integrationID?: string;
  name?: string;
  activation?: string;
  package?: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}
export type HostProviders = { location?: { directory?: string }; data: V2ProviderEntry[] };

/** integration.connection.resolve 的规范化结果（server host 收集；secret 仅在内存链流动） */
export interface ResolvedCredential {
  kind: "api" | "oauth";
  secret: string;
  expires?: number;
  accountId?: string;
}
/** 凭据束：provider.list（端点白名单/激活态）+ integration resolve（db 凭据，优先） */
export type CredentialBundle = {
  list: HostProviders;
  resolved: Record<ProviderId, ResolvedCredential | null>;
};

export interface HostPort {
  checkLocal(signal: AbortSignal): Promise<LocalCheckResult>;
  readCredentials(signal: AbortSignal): Promise<CredentialBundle>;
}

// 仅取 fetch 的调用签名，不要求 mock 实现 Bun 的附加静态方法。
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface QuotaCacheKey {
  providerId: ProviderId;
  // 完整 SHA-256 十六进制摘要，不得使用原始 secret 或短后缀。
  identityHash: string;
}

// 缓存实现负责身份、格式、年龄及权限校验；未命中或不可用返回 null。
// 保存的持久格式由缓存模块实现，这里仅传递脱敏快照。
export interface QuotaCache {
  load(key: QuotaCacheKey, signal: AbortSignal): Promise<QuotaSnapshot | null>;
  save(key: QuotaCacheKey, snapshot: QuotaSnapshot, signal: AbortSignal): Promise<void>;
}

export type RefreshReason = "startup" | "auto" | "manual";

export interface ProviderService {
  // 完成不代表全部渠道成功，调用方应消费 onChange 的独立渠道状态。
  refresh(reason: RefreshReason): Promise<void>;
  dispose(): void;
}

export interface ProviderServiceOptions {
  host: HostPort;
  clock: Clock;
  fetch: Fetch;
  cache: QuotaCache;
  signal: AbortSignal;
  // 每次发送完整渠道列表，而非单渠道补丁；释放后的迟到结果必须忽略。
  onChange(channels: ChannelView[]): void;
}

export type ProviderServiceFactory = (options: ProviderServiceOptions) => ProviderService;
