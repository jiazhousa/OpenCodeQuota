/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show } from "solid-js";
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import { PROVIDER_IDS } from "../core/contracts.ts";
import type { ChannelView, ViewState, Window } from "../core/contracts.ts";
import { CHANNEL_NAMES, CHANNEL_PHASES, REFRESHING_TEXT, errorText, formatPercent } from "./format.ts";

export interface ViewProps { state: () => ViewState; theme: TuiThemeCurrent }

// —— 水平字符条（展示反馈迭代）——
// 条宽 16：filled = round(clamp(0,100)/100 × 条宽) 个 █ + 其余 ░；
// 仅绘图用 clamp，百分比数字保留原值（>100 原数显示）；null/非法为全 ░ 底条 + —。
// 宽度预算：原生侧栏可用约 37 列 = 标签4+1 + 条12+1 + 百分比≤4+1 + 倒计时≤13。
const BAR_WIDTH = 12;

function barText(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "░".repeat(BAR_WIDTH);
  const filled = Math.round(Math.max(0, Math.min(100, value)) / 100 * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

// 侧栏窗口行的紧凑英文标签；持久快照内的适配器 label 仍为内部规范化值，不在此展示。
const COMPACT_WINDOW_LABELS: Record<Window["kind"], string> = { "5h": "5h", week: "week", mcp: "n/a", unknown: "n/a" };

// 紧凑重置倒计时：沿用既有 ceil 分钟与日历无关剩余时长语义。
export function formatCompactReset(resetAt: number | null, now: number): string {
  if (resetAt === null || !Number.isFinite(resetAt)) return "reset unknown";
  if (resetAt <= now) return "due, refresh";
  const minutes = Math.ceil((resetAt - now) / 60000);
  if (minutes < 60) return `reset in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  // ≥1h 省略分钟段：侧栏概览小时粒度足够，保证整行不超宽被截断。
  if (hours < 24) return `reset in ${hours}h`;
  return `reset in ${Math.floor(hours / 24)}d${hours % 24}h`;
}

// 单行窗口行：标签 + 16 列 █░ 条 + 百分比 + 紧凑倒计时，整行不超 37 列。
// 条统一 primary（用户决策：≥100 不再变 warning 色），未知值 textMuted，无需 span 分段。
function WindowRow(props: { window: Window; theme: TuiThemeCurrent; now: number; id: string }) {
  const usable = () => {
    const value = props.window.usedPercent;
    return value !== null && Number.isFinite(value) && value >= 0;
  };
  const barColor = () => !usable() ? props.theme.textMuted : props.theme.primary;
  // 标签固定 4 列（最长 "week"），条与数值在各窗口行之间列对齐。
  return <text id={props.id} wrapMode="none" flexShrink={0}>
    <span style={{ fg: props.theme.text }}>{`${COMPACT_WINDOW_LABELS[props.window.kind].padEnd(4)} `}</span>
    <span style={{ fg: barColor() }}>{barText(props.window.usedPercent)}</span>
    <span style={{ fg: props.theme.text }}>{` ${formatPercent(props.window.usedPercent)} `}</span>
    <span style={{ fg: props.theme.textMuted }}>{formatCompactReset(props.window.resetAt, props.now)}</span>
  </text>;
}

export function ChannelBlock(props: { channel: ChannelView; theme: TuiThemeCurrent; now: number }) {
  const color = () => props.channel.phase === "error" ? props.theme.error
    : ["cached", "stale", "unsupported"].includes(props.channel.phase) ? props.theme.warning : props.theme.textMuted;
  // 侧栏隐藏 ready 的「Updated」；ready+刷新中 只显示「Refreshing」，其余状态完整保留。
  const statusText = () => {
    if (props.channel.phase === "ready") return props.channel.refreshing ? REFRESHING_TEXT : "";
    return props.channel.refreshing ? `${CHANNEL_PHASES[props.channel.phase]} · ${REFRESHING_TEXT}` : CHANNEL_PHASES[props.channel.phase];
  };
  return <box flexDirection="column" flexShrink={0} gap={0}>
    {/* 渠道名后附订阅档位（GLM Coding Plan (Max) / GPT Pro20x (Pro)），对齐上游展示惯例；缺失时不加。 */}
    <text fg={props.theme.text}>{CHANNEL_NAMES[props.channel.providerId]}{props.channel.snapshot?.plan ? ` (${props.channel.snapshot.plan})` : ""}</text>
    <Show when={statusText()}><text fg={color()}>{statusText()}</text></Show>
    <Show when={props.channel.error}><text fg={props.theme.warning} wrapMode="word">{errorText(props.channel.error)}</text></Show>
    <Show when={props.channel.snapshot}>{(snapshot) => <>
      {/* 每渠道窗口纵向排列（5h/week 各一行），MCP 窗口不展示。 */}
      <For each={snapshot().windows.filter((window) => window.kind !== "mcp")}>{(window) =>
        <WindowRow id={`quota-bar-${props.channel.providerId}-${window.id}`} window={window} theme={props.theme} now={props.now} />}
      </For>
      <Show when={props.channel.providerId !== "deepseek" && snapshot().windows.length === 0}><text fg={props.theme.textMuted}>Windows: —</text></Show>
      <For each={snapshot().balances}>{(balance) => <text fg={props.theme.text}>Balance {balance.currency} {balance.amount}</text>}</For>
      <Show when={props.channel.providerId === "deepseek" && snapshot().balances.length === 0}><text fg={props.theme.textMuted}>Balance: —</text></Show>
      {/* 仅保留故障语义的「Account unavailable」，不展示「账户可用」。 */}
      <Show when={snapshot().available === false}><text fg={props.theme.textMuted}>Account unavailable</text></Show>
    </>}</Show>
  </box>;
}

export function LocalStatus(props: ViewProps) {
  const status = () => props.state().localStatus;
  const message = () => {
    const current = status();
    return "error" in current ? errorText(current.error) : "";
  };
  return <>
    <Show when={status().phase === "checking"}><text fg={props.theme.textMuted}>Checking host…</text></Show>
    <Show when={status().phase === "error" || status().phase === "unsupported"}>
      <text fg={props.theme.warning} wrapMode="word">{message()}</text>
    </Show>
  </>;
}

export function Sidebar(props: ViewProps) {
  // 折叠态仅进程内保持，不写宿主配置；写法对齐宿主 sidebar mcp/lsp/todo/files 的
  // box onMouseDown（OpenTUI 原生鼠标事件自命中目标向上传播，text/box 均可绑定）。
  const [collapsed, setCollapsed] = createSignal(false);
  const channels = () => PROVIDER_IDS.flatMap((id) => props.state().channels.filter((channel) => channel.providerId === id && channel.connected));
  // 折叠时仅保留 LocalStatus 的 error/unsupported 异常提示；检查中/空态/渠道全部收起。
  const alerting = () => {
    const phase = props.state().localStatus.phase;
    return phase === "error" || phase === "unsupported";
  };
  return <box id="quota-sidebar" flexDirection="column" flexShrink={0} gap={1}>
    {/* 标题范式对齐宿主 feature-plugins/sidebar/{todo,mcp}.tsx：箭头独立 text 前置（▼ 展开 / ▶ 折叠）+ <b> 加粗标题 + gap={1} 间隔。 */}
    <box id="quota-sidebar-title" flexDirection="row" gap={1} onMouseDown={() => setCollapsed((value) => !value)}>
      <text fg={props.theme.text}>{collapsed() ? "▶" : "▼"}</text>
      <text fg={props.theme.text}><b>Quota</b></text>
    </box>
    <Show when={!collapsed()}>
      <LocalStatus state={props.state} theme={props.theme} />
      <Show when={props.state().localStatus.phase === "ready" && channels().length === 0}><text fg={props.theme.textMuted}>No supported channels</text></Show>
      <For each={channels()}>{(channel) => <box flexDirection="column" flexShrink={0}>
        <ChannelBlock channel={channel} theme={props.theme} now={props.state().now} />
      </box>}</For>
    </Show>
    <Show when={collapsed() && alerting()}>
      <LocalStatus state={props.state} theme={props.theme} />
    </Show>
  </box>;
}
