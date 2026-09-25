/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "@opentui/solid";
import { createTestRenderer } from "@opentui/core/testing";
import { createQuotaPlugin } from "../../src/tui.tsx";
import { Sidebar } from "../../src/ui/Sidebar.tsx";
import { createFakeV2Context, flushPromises, themeFixture, viewFixture } from "../fixtures/fake-host.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function renderer(width = 42, height = 80) {
  const screen = await createTestRenderer({ width, height });
  cleanup.push(() => screen.renderer.destroy());
  return screen;
}

describe("真实 OpenTUI 组件与 slot 挂载", () => {
  test("生产入口注册：id、sidebar.content 追加位与 cleanup 幂等", async () => {
    const screen = await renderer(42, 30);
    const host = createFakeV2Context();
    const plugin = createQuotaPlugin();
    expect(plugin.id).toBe("opencode-channel-quota");
    const dispose = await plugin.setup(host.ctx);
    // 双 slot：sidebar.content（侧栏渲染）+ app（keymap 命令注册——sidebar 树无 KeymapProvider，官方 pattern）。
    expect(host.claims).toHaveLength(2);
    expect(host.claims[0]!.append).toBe("sidebar.content");
    expect(host.claims[1]!.append).toBe("app");
    expect(typeof host.claims[0]!.render).toBe("function");
    await render(() => host.claims[0]!.render() as never, screen.renderer);
    await flushPromises(); await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("▼ Quota");
    // app slot render 执行 keymap.layer 注册 /quota-refresh 命令（palette + slash）。
    host.claims[1]!.render();
    expect(host.layers).toHaveLength(1);
    const layer = host.layers[0] as { mode: string; commands: Array<Record<string, unknown>> };
    expect(layer.mode).toBe("global");
    expect(layer.commands[0]!.id).toBe("quota.refresh");
    expect(layer.commands[0]!.palette).toBe(true);
    expect(layer.commands[0]!.slash).toEqual({ name: "quota-refresh" });
    // cleanup（setup 返回值）：重复调用不得抛出。
    dispose();
    expect(() => dispose()).not.toThrow();
  });

  test("侧栏渲染英文水平条、渠道名与余额，点击折叠/恢复，错误状态英文提示", async () => {
    const screen = await renderer(42, 90);
    const [state, setState] = createSignal(viewFixture());
    const theme = themeFixture();
    await render(() => <Sidebar state={state} theme={theme} />, screen.renderer);
    await screen.renderOnce();
    const lines = () => screen.captureCharFrame().split("\n");
    const sidebarText = () => lines().join("\n");
    // 默认展开标题（箭头前置范式：▼ Quota）与三渠道排序（GLM 词间两个空格）。
    const sidebar = sidebarText();
    expect(sidebar).toContain("▼ Quota");
    expect(sidebar.indexOf("GLM Coding Plan")).toBeGreaterThanOrEqual(0);
    expect(sidebar.indexOf("GLM Coding Plan")).toBeLessThan(sidebar.indexOf("GPT Pro20x"));
    expect(sidebar.indexOf("GPT Pro20x")).toBeLessThan(sidebar.indexOf("DeepSeek"));
    // 水平字符条：125%（clamp 满）整条 16 个 █ + 英文紧凑倒计时。
    const barRow = lines().find((row) => row.includes("125%"))!;
    expect(barRow).toContain("5h");
    expect(barRow).toMatch(/█{12}/);
    expect(barRow).toContain("reset in 1m");
    // 未知值：全 ░ 底条 + — + week 标签 + reset unknown。
    const unknownRow = lines().find((row) => row.includes("reset unknown"))!;
    expect(unknownRow).toContain("week");
    expect(unknownRow).toMatch(/░{12}/);
    expect(unknownRow).toContain("—");
    // 标签固定 4 列：同渠道 5h 与 week 行的条起始列对齐。
    expect(barRow!.indexOf("█")).toBe(unknownRow!.indexOf("░"));
    // DeepSeek 余额英文化保留在侧栏。
    expect(sidebar).toContain("Balance CNY 12.34567890123456789");
    // 点击标题折叠：仅剩标题（+异常提示），渠道/余额收起。
    const title = screen.renderer.root.findDescendantById("quota-sidebar-title")!;
    await screen.mockMouse.click(title.screenX + 2, title.screenY);
    await screen.renderOnce();
    const collapsed = sidebarText();
    expect(collapsed).toContain("▶ Quota");
    expect(collapsed).not.toContain("GLM Coding Plan");
    expect(collapsed).not.toContain("GPT Pro20x");
    expect(collapsed).not.toContain("DeepSeek");
    expect(collapsed).not.toContain("125%");
    // 折叠态仍保留 LocalStatus 的 error/unsupported 英文异常提示。
    setState((view) => ({ ...view, localStatus: { phase: "unsupported", error: { code: "local_unsupported" } } }));
    await screen.renderOnce();
    expect(sidebarText()).toContain("Only the standard local TUI is supported");
    // 再点恢复：渠道与水平条回来。
    await screen.mockMouse.click(title.screenX + 2, title.screenY);
    await screen.renderOnce();
    expect(sidebarText()).toContain("GLM Coding Plan");
    expect(sidebarText()).toContain("125%");
  });
});
