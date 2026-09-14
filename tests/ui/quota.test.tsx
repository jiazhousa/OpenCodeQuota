/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "@opentui/solid";
import { createTestRenderer } from "@opentui/core/testing";
import type { TuiPluginMeta } from "@opencode-ai/plugin/tui";
import { createQuotaPlugin } from "../../src/tui.tsx";
import { Sidebar } from "../../src/ui/Sidebar.tsx";
import { Details } from "../../src/ui/Details.tsx";
import { createFakeHost, flushPromises, themeFixture, viewFixture } from "../fixtures/fake-host.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function renderer(width = 42, height = 80) {
  const screen = await createTestRenderer({ width, height });
  cleanup.push(() => screen.renderer.destroy());
  return screen;
}

describe("真实 OpenTUI 组件与 slot 挂载", () => {
  test("生产入口注册：id、order600、sidebar_content 与两个本地 slash 命令", async () => {
    const screen = await renderer(42, 30);
    const host = createFakeHost({ renderer: screen.renderer });
    cleanup.push(host.dispose);
    const plugin = createQuotaPlugin();
    expect(plugin.id).toBe("opencode-channel-quota");
    expect(plugin.server).toBeUndefined();
    await plugin.tui(host.api, undefined, {} as TuiPluginMeta);
    expect(host.registrations).toHaveLength(1);
    // 原生 Context/MCP/LSP/Todo/Files 为 100–500；600 保证原生区块在前。
    expect(host.registrations[0]!.order).toBe(600);
    expect(Object.keys(host.registrations[0]!.slots)).toEqual(["sidebar_content"]);
    expect(host.layers.flatMap((layer) => [...layer.commands ?? []]).map((command) => ({ name: command.name, slash: command.slashName, namespace: command.namespace, category: command.category }))).toEqual([
      { name: "quota.show", slash: "quota", namespace: "palette", category: "额度" },
      { name: "quota.refresh", slash: "quota-refresh", namespace: "palette", category: "额度" },
    ]);
    const Slot = host.Slot!;
    await render(() => <Slot name="sidebar_content" mode="append" session_id="session-a" />, screen.renderer);
    await flushPromises(); await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("Quota ▾");
    expect(host.registry!.getPluginErrors()).toHaveLength(0);
  });

  test("侧栏渲染水平条与渠道名，点击折叠/恢复，Details 含消费累计", async () => {
    const screen = await renderer(42, 90);
    const [state, setState] = createSignal(viewFixture());
    const theme = themeFixture();
    await render(() => <><Sidebar state={state} theme={theme} /><Details state={state} theme={theme} /></>, screen.renderer);
    await screen.renderOnce();
    // Details 渲染在同帧后半段：侧栏断言只取「Quota 与本地消费」标题之前的行。
    const lines = () => screen.captureCharFrame().split("\n");
    const sidebarText = () => {
      const rows = lines();
      const cut = rows.findIndex((row) => row.includes("Quota 与本地消费"));
      return cut === -1 ? rows.join("\n") : rows.slice(0, cut).join("\n");
    };
    // 默认展开标题与三渠道排序（GLM 词间两个空格）。
    const sidebar = sidebarText();
    expect(sidebar).toContain("Quota ▾");
    expect(sidebar.indexOf("GLM Coding Plan")).toBeGreaterThanOrEqual(0);
    expect(sidebar.indexOf("GLM Coding Plan")).toBeLessThan(sidebar.indexOf("GPT Pro20x"));
    expect(sidebar.indexOf("GPT Pro20x")).toBeLessThan(sidebar.indexOf("DeepSeek"));
    // 水平字符条：125%（clamp 满）整条 16 个 █；未知值全 ░ 底条 + — 与重置未知。
    const barRow = lines().find((row) => row.includes("125%"))!;
    expect(barRow).toContain("5h");
    expect(barRow).toMatch(/█{16}/);
    const unknownRow = lines().find((row) => row.includes("重置未知"))!;
    expect(unknownRow).toContain("周");
    expect(unknownRow).toMatch(/░{16}/);
    expect(unknownRow).toContain("—");
    // DeepSeek 余额保留在侧栏。
    expect(sidebar).toContain("USD 12.34567890123456789");
    // 点击标题折叠：仅剩标题（+异常提示），渠道/空态/余额收起。
    const title = screen.renderer.root.findDescendantById("quota-sidebar-title")!;
    await screen.mockMouse.click(title.screenX + 2, title.screenY);
    await screen.renderOnce();
    const collapsed = sidebarText();
    expect(collapsed).toContain("Quota ▸");
    expect(collapsed).not.toContain("GLM Coding Plan");
    expect(collapsed).not.toContain("GPT Pro20x");
    expect(collapsed).not.toContain("DeepSeek");
    expect(collapsed).not.toContain("125%");
    // 折叠态仍保留 LocalStatus 的 error/unsupported 异常提示。
    setState((view) => ({ ...view, localStatus: { phase: "unsupported", error: { code: "local_unsupported" } } }));
    await screen.renderOnce();
    expect(sidebarText()).toContain("仅支持标准本地 TUI");
    // 再点恢复：渠道与水平条回来。
    await screen.mockMouse.click(title.screenX + 2, title.screenY);
    await screen.renderOnce();
    expect(sidebarText()).toContain("GLM Coding Plan");
    expect(sidebarText()).toContain("125%");
    // 同一状态源的 Details 含本地消费明细与累计。
    expect(screen.captureCharFrame()).toContain("本地消费 · 部分统计");
    expect(screen.captureCharFrame()).toContain("累计 USD 3.25（估算）");
  });
});
