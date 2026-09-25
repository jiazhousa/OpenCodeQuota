// server 侧 RPC 契约测试：view/refresh handler 注册与返回形态（空宿主域 → 零请求快速完成）。
import { describe, expect, test } from "bun:test";
import { createQuotaServerPlugin } from "../../src/server.ts";

type Handler = (input: unknown, context: unknown) => Promise<unknown>;

function fakeServerContext() {
  const handlers = new Map<string, Handler>();
  const ctx = {
    app: { version: "2.0.16-test" },
    provider: { list: async () => ({ data: [] }) },
    integration: { connection: { active: async () => null, resolve: async () => null } },
    rpc: {
      register: async (_definition: unknown, defs: Record<string, Handler>) => {
        for (const [method, handler] of Object.entries(defs)) handlers.set(method, handler);
        return { events: { emit: async () => {} }, dispose: async () => {} };
      },
    },
  };
  return { ctx, handlers };
}

describe("server RPC 契约", () => {
  test("注册 view 与 refresh 两个方法，view 返回脱敏快照", async () => {
    const { ctx, handlers } = fakeServerContext();
    const plugin = createQuotaServerPlugin();
    expect(plugin.id).toBe("opencode-channel-quota");
    const dispose = await plugin.setup(ctx as never);
    expect([...handlers.keys()].sort()).toEqual(["refresh", "view"]);
    const view = await handlers.get("view")!({}, {}) as Record<string, unknown>;
    expect(Array.isArray(view.channels)).toBe(true);
    expect(typeof view.now).toBe("number");
    expect(() => dispose()).not.toThrow();
  });

  test("refresh handler 完成手动刷新后返回最新快照", async () => {
    const { ctx, handlers } = fakeServerContext();
    const plugin = createQuotaServerPlugin();
    const dispose = await plugin.setup(ctx as never);
    // 空宿主域：credentials 全 disconnected → refresh 零请求快速完成，快照回传。
    const view = await handlers.get("refresh")!({}, {}) as Record<string, unknown>;
    expect(Array.isArray(view.channels)).toBe(true);
    expect((view.channels as Array<{ connected?: boolean }>).every((channel) => channel.connected === false)).toBe(true);
    dispose();
  });
});
