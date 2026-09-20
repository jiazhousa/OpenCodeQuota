/** @jsxImportSource @opentui/solid */
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { Fetch } from "./core/contracts.ts";
import { createQuotaController } from "./runtime/controller.ts";
import { createHostPort } from "./runtime/host.ts";
import { Sidebar } from "./ui/Sidebar.tsx";

export interface QuotaPluginDependencies { fetch?: Fetch }

// 测试入口只替换供应商 fetch；正常入口没有可配置的 mock 模式。
export function createQuotaPlugin(dependencies: QuotaPluginDependencies = {}): TuiPluginModule {
  return {
    id: "opencode-channel-quota",
    async tui(api) {
      const controller = createQuotaController({ host: createHostPort(api), signal: api.lifecycle.signal, fetch: dependencies.fetch });
      api.lifecycle.onDispose(controller.dispose);
      // 宿主按 order 升序渲染原生 Context/MCP/LSP/Todo/Files(100–500)；600 保证原生内容在前。
      api.slots.register({ order: 600, slots: {
        sidebar_content: () => <Sidebar state={controller.state} theme={api.theme.current} />,
      } });
      api.command.register(() => [
        { title: "Refresh Quota", value: "quota.refresh", category: "Quota", slash: { name: "quota-refresh" },
          async onSelect() {
            await controller.refresh();
            if (!api.lifecycle.signal.aborted) api.ui.toast({ variant: "info", message: "Quota refreshed" });
          } },
      ]);
    },
  };
}

export default createQuotaPlugin();
