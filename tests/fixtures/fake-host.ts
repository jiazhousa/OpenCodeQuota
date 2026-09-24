import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import { RGBA } from "@opentui/core";
import { createSignal } from "solid-js";
import type { Clock, TimeoutHandle, ViewState } from "../../src/core/contracts.ts";
import { PROVIDER_IDS } from "../../src/core/contracts.ts";
import type { QuotaTuiContext } from "../../src/tui.tsx";
import { QUOTA_RPC_ID } from "../../src/rpc-def.ts";

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

// V2 CLI 插件 ctx 最小模拟（2.0.16 形态）：client（server.info/provider.list）+ theme 值 + ui.slot 记录 claims。
export interface FakeV2Options {
  version?: string;
  theme?: TuiThemeCurrent;
  sdkFailure?: boolean;
}
export type SlotClaim = { append?: string; render: () => unknown };

export function createFakeV2Context(options: FakeV2Options = {}) {
  const claims: SlotClaim[] = [];
  const events: Array<{ type?: string; data?: unknown }> = [];
  const calls: Array<{ method: string }> = [];
  const ctx: QuotaTuiContext = {
    client: {
      rpc: { call: async (request: { rpcID: string; method: string; input?: unknown }) => {
        calls.push({ method: request.rpcID === QUOTA_RPC_ID && request.method === "view" ? "server.info" : "provider.list" });
        if (options.sdkFailure) throw new Error(SENTINEL);
        return viewFixture();
      } },
      event: { subscribe: async function* (opts?: { signal?: AbortSignal }) {
        for (const event of events) { if (opts?.signal?.aborted) return; yield event; }
        await new Promise<void>((done) => opts?.signal?.addEventListener("abort", () => done()) ?? done());
      } },
    },
    theme: options.theme ?? themeFixture(),
    ui: { slot: (claim: SlotClaim) => { claims.push(claim); } },
  };
  return { ctx, claims, calls, events };
}

// 供 controller/unit 测试继续复用的简单状态信号工厂。
export const stateSignal = createSignal;
