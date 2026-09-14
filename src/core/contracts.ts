import type { ProviderListResponses } from "@opencode-ai/sdk/v2/types";

export const PROVIDER_IDS = [
  "zhipuai-coding-plan",
  "openai",
  "deepseek",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

// 文案只能来自静态映射，不拼接供应商、SDK、认证文件或数据库异常原文。
export const SAFE_ERROR_MESSAGES = {
  aborted: "操作已取消",
  local_unsupported: "仅支持标准本地 TUI，不支持远程或 attach 模式",
  version_unsupported: "仅支持 OpenCode 1.18.30",
  host_unavailable: "无法读取宿主状态",
  credentials_unavailable: "无法读取有效凭据，请检查宿主连接",
  host_restart_required: "凭据已变化，请重启 OpenCode 后重试",
  unsupported_provider: "不支持此自定义供应商连接",
  unsupported_endpoint: "不支持此自定义端点或模型认证配置",
  unsupported_auth: "此认证方式不支持订阅额度查询",
  auth_expired: "登录态已过期，请通过宿主重新连接",
  account_unidentified: "无法识别订阅账号，请通过宿主重新连接",
  auth_error: "认证失败，请检查宿主连接",
  network_error: "网络请求失败",
  timeout: "请求超时",
  rate_limited: "请求受限，请在冷却结束后重试",
  http_error: "供应商请求失败",
  response_too_large: "响应超过安全大小限制",
  schema_error: "供应商响应格式无法识别",
  path_unavailable: "无法确定本地存储路径",
  database_ambiguous: "存在不明确的数据库，请使用宿主 OPENCODE_DB 指定路径",
  database_unavailable: "本地数据库不可读",
  database_schema_error: "本地数据库格式不受支持",
  database_busy: "本地数据库繁忙，请稍后重试",
  worker_unavailable: "本地消费统计不可用",
  worker_timeout: "本地消费统计延迟，请稍后校准",
  internal_error: "暂时无法完成操作",
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

export type SpendPhase = "loading" | "ready" | "partial" | "stale" | "error";

export interface SpendSnapshot {
  phase: SpendPhase;
  currency: "USD";
  today: number | null;
  week: number | null;
  month: number | null;
  total: number | null;
  updatedAt?: number;
  timezone: string;
  periodStart: { day: number; week: number; month: number };
  validCount: number;
  invalidCount: number;
  unknownCount: number;
  zeroCount: number;
  error?: SafeError;
}

export type LocalCheckResult =
  | { ok: true }
  | { ok: false; error: SafeError };

export type LocalStatus =
  | { phase: "checking" }
  | { phase: "ready" }
  | { phase: "unsupported" | "error"; error: SafeError };

// 这是唯一视图边界，不接纳原始 Provider、认证对象或 Worker 元数据。
export interface ViewState {
  channels: ChannelView[];
  spend: SpendSnapshot;
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

export type CostChange =
  | { kind: "message"; id: string }
  | { kind: "session"; id: string }
  | { kind: "reset" };

// 使用锁版 SDK 的成功响应 data，不能误用同名的请求参数 ProviderListData。
// 该原始数据仅在宿主适配与凭据服务之间流动，不能进入 ViewState。
export type HostProviders = ProviderListResponses[200];

export interface HostPort {
  checkLocal(signal: AbortSignal): Promise<LocalCheckResult>;
  readProviders(signal: AbortSignal): Promise<HostProviders>;
  subscribeCost(onChange: (change: CostChange) => void): Dispose;
}

export type Env = Readonly<Record<string, string | undefined>>;

// 只读认证文件适配：返回最多 1 MiB 文本，文件不存在为 null。
// 显式 OPENCODE_AUTH_CONTENT 的优先级与解析由凭据模块处理，不回退文件。
// 原文只在凭据模块内部短暂使用，失败不得将原文放入异常或状态。
export type ReadAuth = (path: string, signal: AbortSignal) => Promise<string | null>;

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
  env: Env;
  readAuth: ReadAuth;
  fetch: Fetch;
  cache: QuotaCache;
  signal: AbortSignal;
  // 每次发送完整渠道列表，而非单渠道补丁；释放后的迟到结果必须忽略。
  onChange(channels: ChannelView[]): void;
}

export type ProviderServiceFactory = (options: ProviderServiceOptions) => ProviderService;

export interface SpendPort {
  start(): Promise<void>;
  change(change: CostChange): void;
  reconcile(): Promise<void>;
  tick(now: number): void;
  dispose(): void;
}

export interface SpendOptions {
  dbPath: string;
  clock: Clock;
  signal: AbortSignal;
  // 只发送脱敏统计快照，不暴露 SQL、消息正文或 Worker RPC。
  onChange(snapshot: SpendSnapshot): void;
}

export type SpendFactory = (options: SpendOptions) => SpendPort;
