import { describe, expect, test } from "bun:test";
import { aggregateSpend, periodStart, type CostRow } from "../../src/spend/aggregate.ts";
import { SpendReader } from "../../src/spend/reader.ts";
import { NOW, createSpendFixture } from "../fixtures/spend-db.ts";

function row(id: string, cost: number, createdAt = NOW): CostRow {
  return { id, sessionId: "synthetic", kind: "valid", cost, createdAt };
}

describe("本地消费核心（精简版）", () => {
  test("消息级 provider 归属与 cost 取最新累计", () => {
    const fixture = createSpendFixture();
    try {
      const reader = new SpendReader(fixture.path);
      fixture.messages([
        { id: "a", data: { role: "assistant", providerID: "deepseek", cost: 0.25 } },
        { id: "u", data: { role: "user", providerID: "deepseek", cost: 9 } },
        { id: "o", data: { role: "assistant", providerID: "openai", cost: 9 } },
        { id: "bad", raw: "{oops" },
      ]);
      // 仅 deepseek assistant 计费；user/其他 provider 排除，坏 JSON 计未知并标 partial。
      expect(reader.full(NOW)).toMatchObject({ phase: "partial", total: 0.25, validCount: 1, unknownCount: 1 });
      // 同一 message id 的 cost 是宿主累计值：重读后取最新值，不做增量叠加。
      fixture.message({ id: "a", data: { role: "assistant", providerID: "deepseek", cost: 1.5 } });
      expect(reader.full(NOW)).toMatchObject({ total: 1.5, validCount: 1 });
    } finally { fixture.close(); }
  });

  test("本地时区周一起始与日界：周日回退到本周一，跨本地 0 点重分桶", () => {
    // 2026-09-13 是周日；其周一制的周起点为 2026-09-07（本地 0 点）。
    const sunday = new Date(2026, 8, 13, 12).getTime();
    const start = periodStart(sunday);
    expect(start.week).toBe(new Date(2026, 8, 7).getTime());
    expect(start.day).toBe(new Date(2026, 8, 13).getTime());
    const rows = [
      row("sat", 1, new Date(2026, 8, 12, 23, 59, 59).getTime()),
      row("midnight", 2, new Date(2026, 8, 13).getTime()),
      row("noon", 4, sunday),
    ];
    expect(aggregateSpend(rows, sunday, NOW)).toMatchObject({ today: 6, total: 7, phase: "ready" });
  });

  test("fork 复制新 id 不做启发式去重，按现存记录计数", () => {
    const rows = [row("fork-original", 8), row("fork-copy", 8)];
    expect(aggregateSpend(rows, NOW, NOW)).toMatchObject({ total: 16, validCount: 2, phase: "ready" });
  });
});
