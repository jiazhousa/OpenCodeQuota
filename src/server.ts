// OpenCode V2 server 侧插件入口（数据层宿主）：凭据收集（integration.connection.resolve）
// + controller 数据层 + RPC view 方法与 updated 事件广播。
// 官方双入口结构（docs/build/plugins/cli）：server 进程加载本文件，CLI 进程加载 ./tui 入口（src/tui.tsx）。
import type { Fetch, ViewState } from "./core/contracts.ts";
import { createQuotaController } from "./runtime/controller.ts";
import { createServerHostPort, type V2ServerContext } from "./runtime/host.ts";
import { QUOTA_PLUGIN_ID, QUOTA_RPC_DEF } from "./rpc-def.ts";

export interface QuotaServerContext extends V2ServerContext {
  rpc: {
    register(
      definition: unknown,
      handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>,
    ): Promise<{ events: { emit(name: string, data: unknown): Promise<void> }; dispose(): Promise<void> }>;
  };
}

export interface QuotaServerDependencies { fetch?: Fetch }

// 测试入口只替换供应商 fetch；正常入口没有可配置的 mock 模式。
export function createQuotaServerPlugin(dependencies: QuotaServerDependencies = {}): {
  id: string;
  setup(ctx: QuotaServerContext): Promise<() => void>;
} {
  return {
    id: QUOTA_PLUGIN_ID,
    async setup(ctx) {
      // server 进程即宿主：无远程判定，版本门由 host port 守。
      const lifetime = new AbortController();
      const registration = await ctx.rpc.register(QUOTA_RPC_DEF, {
        view: async () => viewSnapshot(controller.state()),
        // 手动刷新（CLI 侧 /quota-refresh 命令）：等待 controller.refresh 完成后回传最新快照。
        refresh: async () => { await controller.refresh(); return viewSnapshot(controller.state()); },
      });
      const controller = createQuotaController({
        host: createServerHostPort(ctx),
        signal: lifetime.signal,
        fetch: dependencies.fetch,
        onState: (view) => { void registration.events.emit("updated", viewSnapshot(view)).catch(() => {}); },
      });
      return () => {
        lifetime.abort();
        controller.dispose();
        void registration.dispose().catch(() => {});
      };
    },
  };
}

/** ViewState → RPC 载荷（结构化克隆脱敏快照；凭据从不进入 ViewState） */
function viewSnapshot(view: ViewState): ViewState {
  return structuredClone(view);
}

export default createQuotaServerPlugin();
