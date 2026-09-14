import type { SpendSnapshot } from "../core/contracts.ts";

// 只保留计数所需元数据，不保存原始 JSON、模型响应或异常。
export type CostRow = {
  id: string;
  sessionId: string;
} & (
  | { kind: "valid"; cost: number; createdAt: number }
  | { kind: "excluded" }
  | { kind: "invalid" }
  | { kind: "unknown" }
);

export function periodStart(now: number): SpendSnapshot["periodStart"] {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const week = new Date(day);
  week.setDate(week.getDate() - (week.getDay() + 6) % 7);
  const month = new Date(day);
  month.setDate(1);
  return { day: day.getTime(), week: week.getTime(), month: month.getTime() };
}

export function createLoadingSpendSnapshot(now: number): SpendSnapshot {
  return {
    phase: "loading", currency: "USD", today: null, week: null, month: null, total: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    periodStart: periodStart(now), validCount: 0, invalidCount: 0, unknownCount: 0, zeroCount: 0,
  };
}

class Sum {
  value = 0;
  private compensation = 0;
  add(amount: number): void {
    const corrected = amount - this.compensation;
    const next = this.value + corrected;
    this.compensation = (next - this.value) - corrected;
    this.value = next;
  }
  result(): number | null {
    return Number.isFinite(this.value) ? this.value : null;
  }
}

export function aggregateSpend(rows: Iterable<CostRow>, now: number, updatedAt: number): SpendSnapshot {
  const snapshot = createLoadingSpendSnapshot(now);
  const sums = { today: new Sum(), week: new Sum(), month: new Sum(), total: new Sum() };
  for (const row of rows) {
    if (row.kind === "excluded") continue;
    if (row.kind === "invalid") { snapshot.invalidCount++; continue; }
    if (row.kind === "unknown") { snapshot.unknownCount++; continue; }
    if (row.createdAt > now) { snapshot.unknownCount++; continue; }
    snapshot.validCount++;
    if (row.cost === 0) snapshot.zeroCount++;
    sums.total.add(row.cost);
    if (row.createdAt >= snapshot.periodStart.day) sums.today.add(row.cost);
    if (row.createdAt >= snapshot.periodStart.week) sums.week.add(row.cost);
    if (row.createdAt >= snapshot.periodStart.month) sums.month.add(row.cost);
  }
  for (const key of ["today", "week", "month", "total"] as const) snapshot[key] = sums[key].result();
  snapshot.updatedAt = updatedAt;
  snapshot.phase = snapshot.invalidCount || snapshot.unknownCount || Object.values(sums).some((sum) => sum.result() === null)
    ? "partial" : "ready";
  return snapshot;
}
