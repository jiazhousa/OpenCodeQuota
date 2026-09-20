import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Event } from "@opencode-ai/sdk/v2";
import type { TuiHostSlotMap, TuiPluginApi, TuiSlotContext, TuiSlotPlugin, TuiThemeCurrent, TuiToast } from "@opencode-ai/plugin/tui";
import { RGBA, type CliRenderer } from "@opentui/core";
import { createSlot, createSolidSlotRegistry, type JSX } from "@opentui/solid";
import { batch, createSignal } from "solid-js";
import type { Clock, HostProviders, TimeoutHandle, ViewState } from "../../src/core/contracts.ts";
import { PROVIDER_IDS } from "../../src/core/contracts.ts";

export const NOW = new Date(2026, 8, 13, 12).getTime();
export const SENTINEL = "synthetic-secret-DO-NOT-RENDER";

export class FakeClock implements Clock {
  time = NOW;
  private next = 0;
  readonly timers = new Map<number, { at: number; fn(): void }>();
  now = () => this.time;
  setTimeout(fn: () => void, delay: number): number {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + delay, fn });
    return id;
  }
  clearTimeout(handle: TimeoutHandle): void { this.timers.delete(Number(handle)); }
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
    }
    this.time = end;
  }
}

export async function flushPromises(): Promise<void> {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

export function viewFixture(): ViewState {
  return {
    now: NOW, localStatus: { phase: "ready" },
    channels: PROVIDER_IDS.map((providerId) => ({
      providerId, connected: true, phase: providerId === "openai" ? "cached" : "ready", refreshing: providerId === "openai",
      snapshot: {
        providerId, fetchedAt: NOW - 60000, plan: providerId === "openai" ? "Plus" : null, available: providerId === "deepseek" ? true : null,
        windows: providerId === "deepseek" ? [] : [
          { id: "primary_window", kind: "5h", label: "5 小时", usedPercent: 125, resetAt: NOW + 60000 },
          { id: "secondary_window", kind: "week", label: "周额度", usedPercent: null, resetAt: null },
        ],
        balances: providerId === "deepseek" ? [{ currency: "CNY", amount: "12.34567890123456789" }] : [],
      },
    })),
  };
}

export function themeFixture(mode: "dark" | "light" = "dark"): TuiThemeCurrent {
  const text = RGBA.fromHex(mode === "dark" ? "#eeeeee" : "#111111");
  const values = {
    text, textMuted: RGBA.fromHex(mode === "dark" ? "#aaaaaa" : "#555555"),
    background: RGBA.fromHex(mode === "dark" ? "#111111" : "#eeeeee"),
    backgroundElement: RGBA.fromHex(mode === "dark" ? "#333333" : "#cccccc"),
    primary: RGBA.fromHex("#4488cc"), warning: RGBA.fromHex("#cc8800"), error: RGBA.fromHex("#cc3333"),
  };
  // 未用到的宿主主题字段用统一颜色补齐；组件仍读取真实 RGBA 字段。
  return new Proxy(values, { get: (target, key) => key === "thinkingOpacity" ? 0.5 : Reflect.get(target, key) ?? text }) as TuiThemeCurrent;
}

type Command = ReturnType<Parameters<TuiPluginApi["command"]["register"]>[0]>[number];
export function createFakeHost(options: { renderer?: CliRenderer; baseUrl?: string; version?: string; providers?: HostProviders; theme?: TuiThemeCurrent; sdkFailure?: boolean } = {}) {
  const life = new AbortController();
  const disposers = new Set<() => void | Promise<void>>();
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const requests: Array<{ method: string; url: string }> = [];
  const commands: Command[] = [];
  const registrations: TuiSlotPlugin[] = [];
  const toasts: TuiToast[] = [];
  const [dialogRender, setDialogRender] = createSignal<(() => JSX.Element) | undefined>();
  const [size, setSize] = createSignal<"medium" | "large" | "xlarge">("medium");
  const theme = { current: options.theme ?? themeFixture(), selected: "fixture", ready: true, mode: () => "dark" as const, has: () => true, set: () => true, install: async () => {} };
  const registry = options.renderer ? createSolidSlotRegistry<TuiHostSlotMap, TuiSlotContext>(options.renderer, { theme }) : undefined;
  const client = createOpencodeClient({
    baseUrl: options.baseUrl ?? "http://opencode.internal",
    fetch: (async (input: Request) => {
      requests.push({ method: input.method, url: input.url });
      if (options.sdkFailure) throw new Error(SENTINEL);
      const path = new URL(input.url).pathname;
      if (path === "/api/provider") return Response.json({ location: {}, data: options.providers ?? [] });
      throw new Error("测试禁止其他 SDK 请求");
    }) as typeof fetch,
  });
  const event: TuiPluginApi["event"] = { on(type, handler) {
    const handlers = listeners.get(type) ?? new Set();
    listeners.set(type, handlers);
    const wrapped = handler as unknown as (event: Event) => void;
    handlers.add(wrapped);
    return () => { handlers.delete(wrapped); };
  } };
  const dialog: TuiPluginApi["ui"]["dialog"] = {
    replace(render) {
      // 与宿主一致，replace 先重置 size；测试不能掩盖调用顺序错误。
      setSize("medium");
      setDialogRender(() => render);
    },
    clear: () => batch(() => { setSize("medium"); setDialogRender(undefined); }),
    setSize,
    get size() { return size(); }, get depth() { return dialogRender() ? 1 : 0; }, get open() { return !!dialogRender(); },
  };
  const usedApi = {
    client, event, theme,
    lifecycle: { signal: life.signal, onDispose(fn: () => void | Promise<void>) { disposers.add(fn); return () => { disposers.delete(fn); }; } },
    slots: { register(plugin: TuiSlotPlugin) {
      registrations.push(plugin);
      const id = `fixture-slot-${registrations.length}`;
      if (registry) disposers.add(registry.register({ ...plugin, id }));
      return id;
    } },
    app: { version: options.version ?? "2.0.11" },
    command: { register(callback: () => Command[]) { commands.push(...callback()); return () => {}; }, trigger: () => {}, show: () => {} },
    ui: { dialog, toast: (toast: TuiToast) => toasts.push(toast) },
  };
  // 仅补宿主壳，不替代 Sidebar。任何越出已声明 API 的访问立即失败。
  const api = new Proxy(usedApi, { get(target, key) {
    if (key in target) return Reflect.get(target, key);
    throw new Error(`测试未提供宿主字段：${String(key)}`);
  } }) as unknown as TuiPluginApi;
  return {
    api, requests, commands, registrations, toasts, dialogRender, registry,
    Slot: registry ? createSlot(registry) : undefined,
    listeners,
    emit(event: { type: string; properties: unknown }) {
      for (const handler of listeners.get(event.type) ?? []) handler(event as Event);
    },
    async command(name: string) {
      const command = commands.find((command) => command.value === name);
      if (!command) throw new Error("命令未注册");
      // 回调只执行插件本地逻辑，不提供会话写入或模型调用上下文。
      await command.onSelect?.();
    },
    async dispose() {
      life.abort();
      for (const dispose of disposers) await dispose();
      disposers.clear();
      dialog.clear();
      registry?.clear();
    },
  };
}
