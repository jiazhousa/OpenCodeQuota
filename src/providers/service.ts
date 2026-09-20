import { PROVIDER_IDS } from "../core/contracts.ts";
import type { ChannelView, HostProviders, ProviderServiceFactory, QuotaSnapshot, SafeError, TimeoutHandle } from "../core/contracts.ts";
import { resolveCredential } from "./credentials.ts";
import type { Credential, CredentialResult } from "./credentials.ts";
import { parserError, requestQuota, retryable } from "./http.ts";
import { parseGlm } from "./glm.ts";
import { parseOpenai } from "./openai.ts";
import { parseDeepseek } from "./deepseek.ts";

const PERIOD = 900000;
interface Channel {
  view: ChannelView;
  credential?: Credential;
  generation: number;
  controller: AbortController;
  flight?: Promise<void>;
  cooldownUntil: number;
  dueAt: number;
}
const unsupported = (error: SafeError) => ["unsupported_provider", "unsupported_endpoint", "unsupported_auth"].includes(error.code);
export const createProviderService: ProviderServiceFactory = (options) => {
  const { host, clock, fetch, cache, signal, onChange } = options;
  const lifetime = new AbortController();
  const channels: Channel[] = PROVIDER_IDS.map((providerId) => ({
    view: { providerId, connected: false, phase: "disconnected", refreshing: false },
    generation: 0, controller: new AbortController(), cooldownUntil: 0, dueAt: 0,
  }));
  let disposed = false;
  let timer: TimeoutHandle | undefined;
  let discovery: Promise<{ providers: HostProviders } | SafeError> | undefined;
  let manualFlight: Promise<void> | undefined;
  let manualUntil = 0;
  let discoveryEpoch = 0;
  const emit = () => {
    if (!disposed) onChange(structuredClone(channels.map((channel) => channel.view)));
  };
  const valid = (channel: Channel, generation: number) => !disposed && channel.generation === generation && !channel.controller.signal.aborted;
  const isolate = (channel: Channel) => {
    channel.generation++;
    channel.controller.abort();
    channel.controller = new AbortController();
    channel.credential = undefined;
    channel.flight = undefined;
    channel.view = { providerId: channel.view.providerId, connected: channel.view.connected, phase: "loading", refreshing: false };
  };
  const failure = (channel: Channel, error: SafeError) => {
    channel.view = { ...channel.view, phase: channel.view.snapshot ? "stale" : unsupported(error) ? "unsupported" : "error", refreshing: false, error };
    emit();
  };
  const discover = () => {
    if (discovery) return discovery;
    discovery = (async () => {
      try {
        const local = await host.checkLocal(lifetime.signal);
        if (!local.ok) return { code: local.error.code } as SafeError;
        if (disposed) return { code: "aborted" } as SafeError;
        const providers = await host.readProviders(lifetime.signal);
        if (disposed) return { code: "aborted" } as SafeError;
        if (!Array.isArray(providers)) return { code: "host_unavailable" } as SafeError;
        return { providers };
      } catch { return { code: "host_unavailable" } as SafeError; }
    })().finally(() => { discovery = undefined; });
    return discovery;
  };
  const apply = (channel: Channel, result: CredentialResult) => {
    if (!result.connected) {
      isolate(channel);
      channel.view = { providerId: channel.view.providerId, connected: false, phase: "disconnected", refreshing: false };
      return;
    }
    channel.view.connected = true;
    if ("error" in result) {
      isolate(channel);
      failure(channel, result.error);
      return;
    }
    if (channel.credential?.identityHash !== result.credential.identityHash) isolate(channel);
    channel.credential = result.credential;
  };
  const wait = (ms: number, abortSignal: AbortSignal) => new Promise<void>((resolve) => {
    if (abortSignal.aborted || disposed) { resolve(); return; }
    const done = () => { clock.clearTimeout(handle); abortSignal.removeEventListener("abort", done); resolve(); };
    const handle = clock.setTimeout(done, ms);
    abortSignal.addEventListener("abort", done, { once: true });
  });
  const schedule = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    if (disposed) return;
    const due = Math.min(...channels.map((channel) => Math.max(channel.dueAt, channel.cooldownUntil)));
    timer = clock.setTimeout(() => { timer = undefined; void refresh("auto"); }, Math.max(1, due - clock.now()));
  };
  const query = (channel: Channel): Promise<void> => {
    if (channel.flight) return channel.flight;
    if (!channel.credential || disposed || clock.now() < channel.cooldownUntil) return Promise.resolve();
    // 旧代请求取消后可能先结束其全局刷新；此时新代仍在查询，不能被调度器忙轮询。
    channel.dueAt = clock.now() + PERIOD;
    let generation = channel.generation;
    const work = async () => {
      let credential = channel.credential!;
      if (!channel.view.snapshot) {
        try {
          const saved = await cache.load({ providerId: credential.providerId, identityHash: credential.identityHash }, channel.controller.signal);
          if (!valid(channel, generation)) return;
          if (saved) { channel.view = { ...channel.view, snapshot: saved, phase: "cached" }; emit(); }
        } catch { /* 缓存不可用不阻断取数。 */ }
      }
      if (!valid(channel, generation)) return;
      channel.view = { ...channel.view, refreshing: true, lastAttemptAt: clock.now(), ...(channel.view.snapshot ? {} : { phase: "loading" as const }) };
      emit();
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!valid(channel, generation)) return;
        if (credential.expires !== undefined && credential.expires <= clock.now()) {
          isolate(channel);
          failure(channel, { code: "auth_expired" });
          return;
        }
        const response = await requestQuota(credential, fetch, clock, channel.controller.signal);
        if (!valid(channel, generation)) return;
        let error: SafeError;
        if (response.ok) {
          try {
            const parse = credential.providerId === "openai" ? parseOpenai : credential.providerId === "deepseek" ? parseDeepseek : parseGlm;
            const snapshot: QuotaSnapshot = parse(response.data, response.receivedAt);
            channel.view = { providerId: credential.providerId, connected: true, phase: "ready", snapshot, refreshing: false, lastAttemptAt: channel.view.lastAttemptAt };
            channel.dueAt = clock.now() + PERIOD;
            emit();
            if (valid(channel, generation)) await cache.save({ providerId: credential.providerId, identityHash: credential.identityHash }, snapshot, channel.controller.signal).catch(() => {});
            return;
          } catch (caught) { error = parserError(caught); }
        } else error = response.error;
        if (error.retryAt !== undefined) channel.cooldownUntil = Math.max(channel.cooldownUntil, error.retryAt);
        if (attempt === 0 && error.httpStatus === 401) {
          const epoch = discoveryEpoch;
          const latest = await discover();
          if (!valid(channel, generation) || epoch !== discoveryEpoch) return;
          if ("code" in latest) { failure(channel, latest); return; }
          const resolved = resolveCredential(channel.view.providerId, latest.providers);
          if (!resolved.connected || "error" in resolved) { apply(channel, resolved); emit(); return; }
          if (resolved.credential.identityHash !== credential.identityHash) {
            // 保持当前单 flight 所有权，先隔离旧身份，再消耗同一轮的剩余一次预算。
            channel.controller.abort();
            channel.controller = new AbortController();
            channel.generation++;
            generation = channel.generation;
            channel.view = { providerId: channel.view.providerId, connected: true, phase: "loading", refreshing: true, lastAttemptAt: clock.now() };
            emit();
          }
          credential = resolved.credential;
          channel.credential = credential;
          const delay = Math.max(0, channel.cooldownUntil - clock.now());
          if (delay > 30000) { failure(channel, error); return; }
          if (delay) await wait(delay, channel.controller.signal);
          continue;
        }
        if (attempt === 0 && retryable(error)) {
          const delay = Math.max(1000, channel.cooldownUntil - clock.now());
          if (delay <= 30000) { await wait(delay, channel.controller.signal); continue; }
        }
        failure(channel, error);
        return;
      }
    };
    const flight = work().catch(() => {
      if (valid(channel, generation)) failure(channel, { code: "internal_error" });
    }).finally(() => {
      if (valid(channel, generation)) {
        channel.view.refreshing = false;
        channel.dueAt = clock.now() + PERIOD;
        emit();
      }
      if (channel.flight === flight) channel.flight = undefined;
    });
    channel.flight = flight;
    return flight;
  };
  const run = async (reason: "startup" | "auto" | "manual") => {
    const epoch = ++discoveryEpoch;
    const latest = await discover();
    if (disposed || epoch !== discoveryEpoch) return;
    if ("code" in latest) {
      for (const channel of channels) {
        // 无法确认宿主连接时，不继续使用上一轮身份查询。
        isolate(channel);
        failure(channel, latest);
        channel.dueAt = clock.now() + PERIOD;
      }
      schedule();
      return;
    }
    const pending: Promise<void>[] = [];
    for (const channel of channels) {
      const wasDue = clock.now() >= Math.max(channel.dueAt, channel.cooldownUntil);
      let resolved: CredentialResult;
      try { resolved = resolveCredential(channel.view.providerId, latest.providers); }
      catch { resolved = { connected: true, error: { code: "credentials_unavailable" } }; }
      const oldHash = channel.credential?.identityHash;
      apply(channel, resolved);
      // 删除认证后仍保留已见过的来源证据，直到断连或宿主重启，避免下轮又使用旧 key。
      if (channel.view.snapshot && clock.now() - channel.view.snapshot.fetchedAt >= PERIOD) channel.view.phase = "stale";
      if (channel.credential && (reason !== "auto" || wasDue || channel.credential.identityHash !== oldHash)) pending.push(query(channel));
      if (!channel.flight && (wasDue || !channel.credential)) channel.dueAt = clock.now() + PERIOD;
    }
    emit();
    await Promise.all(pending);
    if (!disposed) schedule();
  };
  const refresh = (reason: "startup" | "auto" | "manual"): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (reason !== "manual") return run(reason);
    if (manualFlight) return manualFlight;
    if (clock.now() < manualUntil) return Promise.resolve();
    manualFlight = run(reason).finally(() => { manualUntil = clock.now() + 3000; manualFlight = undefined; });
    return manualFlight;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    if (timer !== undefined) clock.clearTimeout(timer);
    for (const channel of channels) channel.controller.abort();
    signal.removeEventListener("abort", dispose);
  };
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) dispose();
  return { refresh, dispose };
};
