import { createRoot, createSignal } from "solid-js";
import { PROVIDER_IDS } from "../core/contracts.ts";
import type { Clock, Fetch, HostPort, ProviderService, ProviderServiceFactory, QuotaCache, SafeError, TimeoutHandle, ViewState } from "../core/contracts.ts";
import { createQuotaCache } from "../providers/cache.ts";
import { createProviderService } from "../providers/service.ts";

export const platformClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, delay) => globalThis.setTimeout(fn, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export interface ControllerOptions {
  host: HostPort;
  signal: AbortSignal;
  fetch?: Fetch;
  clock?: Clock;
  cache?: QuotaCache;
  providerFactory?: ProviderServiceFactory;
  /** 每次 ViewState 变化后回调（server 侧用于 RPC 事件广播；同步调用，不得抛出） */
  onState?(view: ViewState): void;
}

export function createQuotaController(options: ControllerOptions) {
  return createRoot((disposeRoot) => {
    const clock = options.clock ?? platformClock;
    const lifetime = new AbortController();
    const [state, setState] = createSignal<ViewState>({
      channels: PROVIDER_IDS.map((providerId) => ({ providerId, connected: false, phase: "disconnected", refreshing: false })),
      now: clock.now(), localStatus: { phase: "checking" },
    });
    let disposed = false;
    let providers: ProviderService | undefined;
    let tick: TimeoutHandle | undefined;
    let manual: Promise<void> | undefined;
    let manualUntil = 0;
    const update = (patch: Partial<ViewState>) => {
      if (disposed) return;
      setState((view) => ({ ...view, ...patch }));
      try { options.onState?.(state()); } catch { /* 回调失败不影响状态机 */ }
    };
    const hostError = (error: SafeError) => {
      update({ localStatus: { phase: error.code === "local_unsupported" || error.code === "version_unsupported" ? "unsupported" : "error", error } });
    };
    const runProviders = async (reason: "startup" | "manual") => {
      try { await providers?.refresh(reason); }
      catch { hostError({ code: "host_unavailable" }); }
    };
    // 冷启动自愈（V2 实证 2026-09-25）：隔离/首启环境 provider 目录异步就绪需 ~12s，
    // 启动刷新可能跑在目录之前（凭据集不齐 → 全渠道 disconnected 且零请求）；
    // 无任何 ready 渠道时间隔重试（凭据就绪后 refresh 自然发出请求，幂等：有 ready 即停）。
    let retryTimer: ReturnType<typeof clock.setTimeout> | undefined;
    let retryCount = 0;
    const scheduleStartupRetry = () => {
      if (disposed || retryCount >= 4) return;
      if (state().channels.some((channel) => channel.phase === "ready")) return;
      retryCount += 1;
      retryTimer = clock.setTimeout(() => {
        retryTimer = undefined;
        if (disposed) return;
        void runProviders("manual").then(scheduleStartupRetry);
      }, 15000);
    };
    // tick 仅推进 now（重置倒计时）并把超龄 ready 渠道标记为 stale，不联网。
    const scheduleTick = () => {
      if (disposed) return;
      tick = clock.setTimeout(() => {
        tick = undefined;
        if (disposed) return;
        const now = clock.now();
        update({ now, channels: state().channels.map((channel) => channel.phase === "ready" && channel.snapshot && now - channel.snapshot.fetchedAt >= 900000
          ? { ...channel, phase: "stale" } : channel) });
        scheduleTick();
      }, 30000);
    };
    const initialize = async () => {
      try {
        const local = await options.host.checkLocal(lifetime.signal);
        if (disposed) return;
        if (!local.ok) { hostError(local.error); return; }
        // 缓存目录不可用时 createQuotaCache 自身降级为空操作，不阻断远端额度。
        providers = (options.providerFactory ?? createProviderService)({
          host: options.host, clock, signal: lifetime.signal,
          fetch: options.fetch ?? globalThis.fetch,
          cache: options.cache ?? createQuotaCache({ clock }),
          onChange: (channels) => update({ channels }),
        });
        update({ localStatus: { phase: "ready" } });
        scheduleTick();
        await runProviders("startup");
        scheduleStartupRetry();
      } catch { hostError({ code: "internal_error" }); }
    };
    function dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      if (tick !== undefined) clock.clearTimeout(tick);
      if (retryTimer !== undefined) clock.clearTimeout(retryTimer);
      try { providers?.dispose(); } catch { /* 释放阶段丢弃原始异常。 */ }
      options.signal.removeEventListener("abort", dispose);
      disposeRoot();
    }
    options.signal.addEventListener("abort", dispose, { once: true });
    if (options.signal.aborted) dispose();
    const ready = disposed ? Promise.resolve() : initialize();
    function refresh(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (manual) return manual;
      if (clock.now() < manualUntil) return Promise.resolve();
      manual = ready.then(async () => {
        if (disposed || !providers) return;
        await runProviders("manual");
      }).finally(() => { manual = undefined; manualUntil = clock.now() + 3000; });
      return manual;
    }
    return { state, ready, refresh, dispose };
  });
}
