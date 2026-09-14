/** @jsxImportSource @opentui/solid */
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { Fetch } from "./core/contracts.ts";
import { createQuotaController } from "./runtime/controller.ts";
import { createHostPort } from "./runtime/host.ts";
import { Sidebar } from "./ui/Sidebar.tsx";
import { Details } from "./ui/Details.tsx";

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
      api.keymap.registerLayer({ commands: [
        { name: "quota.show", title: "查看 Quota", category: "额度", namespace: "palette", slashName: "quota", run() {
          if (api.lifecycle.signal.aborted) return;
          api.ui.dialog.replace(() => <Details state={controller.state} theme={api.theme.current} />);
          api.ui.dialog.setSize("large");
        } },
        { name: "quota.refresh", title: "刷新 Quota", category: "额度", namespace: "palette", slashName: "quota-refresh", async run() {
          await controller.refresh();
          if (!api.lifecycle.signal.aborted) api.ui.toast({ variant: "info", message: "刷新已完成，各渠道与本地统计状态请查看额度详情" });
        } },
      ] });
    },
  };
}

export default createQuotaPlugin();
