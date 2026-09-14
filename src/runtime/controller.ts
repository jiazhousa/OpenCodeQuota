import { createRoot, createSignal } from "solid-js";
import { PROVIDER_IDS } from "../core/contracts.ts";
import type { Clock, Env, Fetch, HostPort, ProviderService, ProviderServiceFactory, QuotaCache, ReadAuth, SafeError, SpendFactory, SpendPort, TimeoutHandle, ViewState } from "../core/contracts.ts";
import { createQuotaCache } from "../providers/cache.ts";
import { readAuthFile } from "../providers/credentials.ts";
import { createProviderService } from "../providers/service.ts";
import { createLoadingSpendSnapshot } from "../spend/aggregate.ts";
import { createSpendClient } from "../spend/client.ts";
import { resolveDataDirectory, resolveDatabasePath, resolveStateDirectory } from "../spend/paths.ts";

export const platformClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, delay) => globalThis.setTimeout(fn, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export interface ControllerOptions {
  host: HostPort;
  signal: AbortSignal;
  fetch?: Fetch;
  env?: Env;
  clock?: Clock;
  readAuth?: ReadAuth;
  cache?: QuotaCache;
  providerFactory?: ProviderServiceFactory;
  spendFactory?: SpendFactory;
  databasePath?: typeof resolveDatabasePath;
}

const noCache: QuotaCache = { load: async () => null, save: async () => {} };

export function createQuotaController(options: ControllerOptions) {
  return createRoot((disposeRoot) => {
    const clock = options.clock ?? platformClock;
    const env = options.env ?? process.env;
    const lifetime = new AbortController();
    const [state, setState] = createSignal<ViewState>({
      channels: PROVIDER_IDS.map((providerId) => ({ providerId, connected: false, phase: "disconnected", refreshing: false })),
      spend: createLoadingSpendSnapshot(clock.now()), now: clock.now(), localStatus: { phase: "checking" },
    });
    let disposed = false;
    let providers: ProviderService | undefined;
    let spend: SpendPort | undefined;
    let unsubscribe: (() => void) | undefined;
    let tick: TimeoutHandle | undefined;
    let manual: Promise<void> | undefined;
    let manualUntil = 0;
    const update = (patch: Partial<ViewState>) => { if (!disposed) setState((view) => ({ ...view, ...patch })); };
    const spendError = (error: SafeError) => update({ spend: { ...state().spend, phase: state().spend.updatedAt === undefined ? "error" : "stale", error } });
    const hostError = (error: SafeError) => {
      update({ localStatus: { phase: error.code === "local_unsupported" || error.code === "version_unsupported" ? "unsupported" : "error", error } });
      if (!spend) spendError(error);
    };
    const runProviders = async (reason: "startup" | "manual") => {
      try { await providers?.refresh(reason); }
      catch { hostError({ code: "host_unavailable" }); }
    };
    const runSpend = async (initial: boolean) => {
      try { if (initial) await spend?.start(); else await spend?.reconcile(); }
      catch { spendError({ code: "worker_unavailable" }); }
    };
    const scheduleTick = () => {
      if (disposed) return;
      tick = clock.setTimeout(() => {
        tick = undefined;
        if (disposed) return;
        const now = clock.now();
        update({ now, channels: state().channels.map((channel) => channel.phase === "ready" && channel.snapshot && now - channel.snapshot.fetchedAt >= 900000
          ? { ...channel, phase: "stale" } : channel) });
        try { spend?.tick(now); } catch { spendError({ code: "worker_unavailable" }); }
        scheduleTick();
      }, 30000);
    };
    const initialize = async () => {
      try {
        const local = await options.host.checkLocal(lifetime.signal);
        if (disposed) return;
        if (!local.ok) { hostError(local.error); return; }
        const data = resolveDataDirectory(env);
        if (!data.ok) { hostError(data.error); return; }
        const cachePath = resolveStateDirectory(env);
        providers = (options.providerFactory ?? createProviderService)({
          host: options.host, clock, env, signal: lifetime.signal,
          readAuth: options.readAuth ?? readAuthFile, fetch: options.fetch ?? globalThis.fetch,
          cache: options.cache ?? (cachePath.ok ? createQuotaCache({ env, clock }) : noCache),
          onChange: (channels) => update({ channels }),
        });
        update({ localStatus: { phase: "ready" } });
        scheduleTick();
        // 两条独立通路：数据库失败不阻断远端额度，供应商失败不阻断本地消费。
        await Promise.all([runProviders("startup"), (async () => {
          try {
            const path = await (options.databasePath ?? resolveDatabasePath)(env);
            if (disposed) return;
            if (!path.ok) { spendError(path.error); return; }
            spend = (options.spendFactory ?? createSpendClient)({
              dbPath: path.path, clock, signal: lifetime.signal, onChange: (snapshot) => update({ spend: snapshot }),
            });
            unsubscribe = options.host.subscribeCost((change) => { if (!disposed) spend?.change(change); });
            await runSpend(true);
          } catch { spendError({ code: "worker_unavailable" }); }
        })()]);
      } catch { hostError({ code: "internal_error" }); }
    };
    function dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      if (tick !== undefined) clock.clearTimeout(tick);
      // 独立释放，某个适配器失败不妨碍其他资源回收。
      for (const release of [unsubscribe, () => providers?.dispose(), () => spend?.dispose()]) {
        try { release?.(); } catch { /* 释放阶段丢弃原始异常。 */ }
      }
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
        await Promise.all([runProviders("manual"), runSpend(false)]);
      }).finally(() => { manual = undefined; manualUntil = clock.now() + 3000; });
      return manual;
    }
    return { state, ready, refresh, dispose };
  });
}
