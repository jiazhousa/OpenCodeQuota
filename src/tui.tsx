/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js";
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import { PROVIDER_IDS, type Fetch, type ViewState } from "./core/contracts.ts";
import { Sidebar } from "./ui/Sidebar.tsx";
import { QUOTA_PLUGIN_ID, QUOTA_RPC_ID, QUOTA_RPC_UPDATED_TYPE } from "./rpc-def.ts";

// OpenCode V2（2.0.16）CLI/TUI 侧插件入口：经 RPC 消费 server 侧数据层（src/server.ts）的脱敏快照。
// 官方双入口结构：本文件由 CLI 进程按 package.json exports "./tui" 加载（实证见 docs/compatibility.md）。
export interface QuotaTuiContext {
  client: {
    rpc: { call(request: { rpcID: string; method: string; input?: unknown }): Promise<unknown> };
    event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<{ type?: string; data?: unknown }> };
  };
  theme: TuiThemeCurrent;
  ui: { slot(claim: { append?: string; render: () => unknown }): unknown };
}

export interface QuotaPluginDependencies { fetch?: Fetch }

const initialView = (): ViewState => ({
  channels: PROVIDER_IDS.map((providerId) => ({ providerId, connected: false, phase: "disconnected", refreshing: false })),
  now: Date.now(),
  localStatus: { phase: "checking" },
});

// RPC 载荷防御：只接受 channels 数组 + now 数字的形态（契约外的值一律丢弃，不渲染）。
function sanitizedView(value: unknown): ViewState | null {
  if (typeof value !== "object" || value === null) return null;
  const view = value as Record<string, unknown>;
  if (!Array.isArray(view.channels) || typeof view.now !== "number") return null;
  return value as ViewState;
}

// V1 Sidebar 消费扁平色键（text/textMuted/primary/warning/error）；V2 ctx.theme 为嵌套语义 token
// （2.0.16 实测：text.base / text.muted / text.feedback.{warning,error}.base）。
// primary 实测坑：V2 主题的 text.action.primary.base 为近白（238,238,238）、hue.blue 系为蓝——均非产品预期；
// 按用户决策（2026-09-25）进度条主色用 Oracle agent 橙 #FF8C00（agents/oracle.md frontmatter color，实测一致）；5h/week/Balance 标签同色。
function adaptTheme(theme: TuiThemeCurrent): TuiThemeCurrent {
  const t = theme as unknown as Record<string, unknown>;
  const pick = (path: string[]): unknown =>
    path.reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), t);
  const isV2Tokens = pick(["text", "base"]) !== undefined;
  return {
    ...t,
    text: pick(["text", "base"]) ?? t.text,
    textMuted: pick(["text", "muted"]) ?? t.textMuted,
    primary: isV2Tokens ? "#FF8C00" : t.primary,
    warning: pick(["text", "feedback", "warning", "base"]) ?? t.warning,
    error: pick(["text", "feedback", "error", "base"]) ?? t.error,
  } as TuiThemeCurrent;
}

// 测试入口只替换供应商 fetch（server 侧）；CLI 侧无远端请求。
export function createQuotaPlugin(_dependencies: QuotaPluginDependencies = {}): {
  id: string;
  setup(ctx: QuotaTuiContext): Promise<() => void>;
} {
  return {
    id: QUOTA_PLUGIN_ID,
    async setup(ctx) {
      const lifetime = new AbortController();
      const [state, setState] = createSignal<ViewState>(initialView());
      const pull = () =>
        ctx.client.rpc.call({ rpcID: QUOTA_RPC_ID, method: "view", input: {} })
          .then((value) => { const view = sanitizedView(value); if (view) setState(() => view); })
          .catch(() => { /* server 侧插件未就绪时保持现有视图 */ });
      void pull();
      // 事件流：rpc.opencode-quota.updated（官方信封 {type, data, location}；data 即快照）。
      void (async () => {
        try {
          for await (const event of ctx.client.event.subscribe({ signal: lifetime.signal })) {
            if (event?.type !== QUOTA_RPC_UPDATED_TYPE) continue;
            const view = sanitizedView(event.data);
            if (view) setState(() => view);
          }
        } catch { /* 流断开由轮询兜底 */ }
      })();
      // 兜底轮询：事件流失效（server 重启窗口等）时 60s 内恢复视图。
      const poll = setInterval(pull, 60000);
      ctx.ui.slot({
        append: "sidebar.content",
        render: () => <Sidebar state={state} theme={adaptTheme(ctx.theme)} />,
      });
      return () => {
        lifetime.abort();
        clearInterval(poll);
      };
    },
  };
}

export default createQuotaPlugin();
