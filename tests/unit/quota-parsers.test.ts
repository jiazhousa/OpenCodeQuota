import { describe, expect, test } from "bun:test";
import { parseGlm } from "../../src/providers/glm.ts";
import { parseOpenai } from "../../src/providers/openai.ts";
import { parseDeepseek } from "../../src/providers/deepseek.ts";

const now = 1800000000000;
const glm = (limits: unknown) => ({ success: true, code: 200, data: { limits } });
describe("国内 GLM 解析", () => {
  test("CREDIT_LIMIT 按单位+数量精确识别，乱序不影响周期，信用值不当 token/金额", () => {
    const snapshot = parseGlm(glm([
      { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 35, nextResetTime: now + 86400000, usage: 20000, currentValue: 7000 },
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 20, nextResetTime: now + 3600000, remaining: 8000 },
      { type: "TOKENS_LIMIT", unit: 6, percentage: 130, nextResetTime: now + 1000 },
      { type: "TOKENS_LIMIT", unit: 3 },
    ]), now);
    expect(snapshot.windows.map((w) => [w.kind, w.label, w.usedPercent, w.resetAt])).toEqual([
      ["week", "周额度", 35, now + 86400000], ["5h", "5 小时", 20, now + 3600000],
      ["week", "周额度", 130, now + 1000], ["5h", "5 小时", null, null],
    ]);
    expect(snapshot.balances).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("currentValue");
    expect(JSON.stringify(snapshot)).not.toContain("remaining");
  });
  test("不支持的单位/数量、未知类型保留 unknown；200 软失败与鉴权码仍失败", () => {
    const limits = [
      { unit: 3 }, { unit: 6 }, { unit: 3, number: 1 }, { unit: 6, number: 2 },
      { unit: 3, number: "5" }, { unit: "3", number: 5 }, { unit: 3, number: 0 },
      { unit: 6, number: null }, { unit: 999, number: 5 }, { number: 5 },
    ].map((item) => ({ type: "CREDIT_LIMIT", percentage: 0, ...item }));
    const windows = parseGlm(glm([...limits, { type: "FUTURE_LIMIT", unit: 3, number: 5 }]), now).windows;
    expect(windows).toHaveLength(11);
    expect(windows.every((w) => w.kind === "unknown" && w.label === "未知窗口")).toBe(true);
    for (const value of [{ success: false, data: { limits: [] }, msg: "secret" }, { code: 500, data: { limits: [] } }, glm({}), glm([{ type: "TOKENS_LIMIT", percentage: -1 }])]) {
      expect(() => parseGlm(value, now)).toThrow();
    }
    try { parseGlm({ code: 401, msg: "secret" }, now); } catch (error) { expect(error).toEqual({ code: "auth_error" }); }
  });
});
describe("OpenAI 解析", () => {
  test("主次交换仍按长度命名，秒转毫秒，缺长度保留未知", () => {
    const snapshot = parseOpenai({ plan_type: "plus", rate_limit: {
      primary_window: { limit_window_seconds: 604800, used_percent: 123, reset_at: now / 1000 + 12 },
      secondary_window: { limit_window_seconds: 18000, used_percent: 0, reset_after_seconds: 5 },
    } }, now);
    expect(snapshot.plan).toBe("Plus");
    expect(snapshot.windows.map((w) => [w.kind, w.usedPercent, w.resetAt])).toEqual([["week", 123, now + 12000], ["5h", 0, now + 5000]]);
    const unknown = parseOpenai({ rate_limit: { primary_window: {} } }, now);
    expect(unknown.windows[0]).toMatchObject({ kind: "unknown", usedPercent: null, resetAt: null });
    expect(parseOpenai({ rate_limit: { primary_window: null } }, now).windows).toEqual([]);
    for (const value of [{}, { rate_limit: null }, { rate_limit: { primary_window: { reset_after_seconds: -1 } } }]) expect(() => parseOpenai(value, now)).toThrow();
  });
});
describe("DeepSeek 精确余额", () => {
  test("十进制原文、负余额及未知合法币种独立保留；浮点/坏结构拒绝", () => {
    const snapshot = parseDeepseek({ is_available: false, balance_infos: [
      { currency: "USD", total_balance: "9007199254740993.000001" },
      { currency: "CNY", total_balance: "-0.0100" },
    ] }, now);
    expect(snapshot.available).toBe(false);
    expect(snapshot.balances).toEqual([{ currency: "USD", amount: "9007199254740993.000001" }, { currency: "CNY", amount: "-0.0100" }]);
    for (const total_balance of [1.2, "1e3", "+1", ""]) {
      expect(() => parseDeepseek({ is_available: true, balance_infos: [{ currency: "USD", total_balance }] }, now)).toThrow();
    }
    for (const data of [{}, { is_available: true, balance_infos: {} }]) expect(() => parseDeepseek(data, now)).toThrow();
  });
});
