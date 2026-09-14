/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show } from "solid-js";
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import { PROVIDER_IDS } from "../core/contracts.ts";
import type { ChannelView, ViewState, Window } from "../core/contracts.ts";
import { CHANNEL_NAMES, CHANNEL_PHASES, SPEND_PHASES, errorText, formatPercent, formatReset, formatTime, formatUsd, progressWidth } from "./format.ts";

export interface ViewProps { state: () => ViewState; theme: TuiThemeCurrent }

// —— 水平字符条（展示反馈迭代）——
// 条宽 16：filled = round(clamp(0,100)/100 × 条宽) 个 █ + 其余 ░；
// 仅绘图用 clamp，百分比数字保留原值（>100 原数显示）；null/非法为全 ░ 底条 + —。
const BAR_WIDTH = 16;

function barText(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "░".repeat(BAR_WIDTH);
  const filled = Math.round(Math.max(0, Math.min(100, value)) / 100 * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

// 侧栏窗口行的紧凑标签；详情仍用适配器规范化的完整 label。
const COMPACT_WINDOW_LABELS: Record<Window["kind"], string> = { "5h": "5h", week: "周", mcp: "未知", unknown: "未知" };

// 紧凑重置倒计时：沿用既有 ceil 分钟与日历无关剩余时长语义。
export function formatCompactReset(resetAt: number | null, now: number): string {
  if (resetAt === null || !Number.isFinite(resetAt)) return "重置未知";
  if (resetAt <= now) return "待刷新";
  const minutes = Math.ceil((resetAt - now) / 60000);
  if (minutes < 60) return `${minutes}m重置`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m重置`;
  return `${Math.floor(hours / 24)}d${hours % 24}h重置`;
}

// 单行窗口行：标签 + 16 列 █░ 条 + 百分比 + 紧凑倒计时，整行不超 37 列。
// 条整体一色：primary（≥100 用 warning，未知值用 textMuted），无需 span 分段。
function WindowRow(props: { window: Window; theme: TuiThemeCurrent; now: number; id: string }) {
  const usable = () => {
    const value = props.window.usedPercent;
    return value !== null && Number.isFinite(value) && value >= 0;
  };
  const barColor = () => !usable() ? props.theme.textMuted
    : (props.window.usedPercent as number) >= 100 ? props.theme.warning : props.theme.primary;
  return <text id={props.id} wrapMode="none" flexShrink={0}>
    <span style={{ fg: props.theme.text }}>{`${COMPACT_WINDOW_LABELS[props.window.kind]} `}</span>
    <span style={{ fg: barColor() }}>{barText(props.window.usedPercent)}</span>
    <span style={{ fg: props.theme.text }}>{` ${formatPercent(props.window.usedPercent)} `}</span>
    <span style={{ fg: props.theme.textMuted }}>{formatCompactReset(props.window.resetAt, props.now)}</span>
  </text>;
}

export function ChannelBlock(props: { channel: ChannelView; theme: TuiThemeCurrent; now: number; details?: boolean }) {
  const color = () => props.channel.phase === "error" ? props.theme.error
    : ["cached", "stale", "unsupported"].includes(props.channel.phase) ? props.theme.warning : props.theme.textMuted;
  // 侧栏隐藏 ready 的「已更新」；ready+刷新中 只显示「刷新中」，其余状态完整保留。
  const statusText = () => {
    if (!props.details && props.channel.phase === "ready") return props.channel.refreshing ? "刷新中" : "";
    return props.channel.refreshing ? `${CHANNEL_PHASES[props.channel.phase]} · 刷新中` : CHANNEL_PHASES[props.channel.phase];
  };
  return <box flexDirection="column" flexShrink={0} gap={0}>
    <text fg={props.theme.text}>{CHANNEL_NAMES[props.channel.providerId]}</text>
    <Show when={statusText()}><text fg={color()}>{statusText()}</text></Show>
    <Show when={props.channel.error}><text fg={props.theme.warning} wrapMode="word">{errorText(props.channel.error)}</text></Show>
    <Show when={props.channel.snapshot}>{(snapshot) => <>
      <Show when={props.details && snapshot().plan}><text fg={props.theme.textMuted}>套餐：{snapshot().plan}</text></Show>
      <Show when={!props.details}>
        {/* 每渠道窗口纵向排列（5h/周各一行），MCP 窗口仅在详情展示。 */}
        <For each={snapshot().windows.filter((window) => window.kind !== "mcp")}>{(window) =>
          <WindowRow id={`quota-bar-${props.channel.providerId}-${window.id}`} window={window} theme={props.theme} now={props.now} />}
        </For>
      </Show>
      <Show when={props.details}><For each={snapshot().windows}>{(window) => <box flexDirection="column" flexShrink={0}>
        <text fg={props.theme.text}>{window.label} 已用 {formatPercent(window.usedPercent)}</text>
        <box height={1} width="100%" backgroundColor={props.theme.backgroundElement}>
          <box height={1} width={progressWidth(window.usedPercent)} backgroundColor={window.usedPercent !== null && window.usedPercent >= 100 ? props.theme.warning : props.theme.primary} />
        </box>
        <text fg={props.theme.textMuted}>{formatReset(window.resetAt, props.now)}</text>
      </box>}</For></Show>
      <Show when={props.channel.providerId !== "deepseek" && snapshot().windows.length === 0}><text fg={props.theme.textMuted}>额度窗口：—</text></Show>
      <For each={snapshot().balances}>{(balance) => <text fg={props.theme.text}>余额 {balance.currency} {balance.amount}</text>}</For>
      <Show when={props.channel.providerId === "deepseek" && snapshot().balances.length === 0}><text fg={props.theme.textMuted}>余额：—</text></Show>
      {/* 侧栏仅保留故障语义的「账户不可用」，不展示「账户可用」。 */}
      <Show when={props.details ? snapshot().available !== null : snapshot().available === false}><text fg={props.theme.textMuted}>{snapshot().available ? "账户可用" : "账户不可用"}</text></Show>
      <Show when={props.details}><text fg={props.theme.textMuted}>远端更新：{formatTime(snapshot().fetchedAt)}</text></Show>
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
    <Show when={status().phase === "checking"}><text fg={props.theme.textMuted}>检查本地宿主…</text></Show>
    <Show when={status().phase === "error" || status().phase === "unsupported"}>
      <text fg={props.theme.warning} wrapMode="word">{message()}</text>
    </Show>
  </>;
}

export function SpendBlock(props: ViewProps & { details?: boolean }) {
  const spend = () => props.state().spend;
  // 侧栏已不再渲染消费区（用户精简指令）；本组件仅供 Details 使用，始终带状态标记。
  const title = () => `本地消费 · ${SPEND_PHASES[spend().phase]}`;
  return <box flexDirection="column" flexShrink={0}>
    <text fg={props.theme.textMuted}>{title()}</text>
    <Show when={spend().error}><text fg={props.theme.warning}>{errorText(spend().error)}</text></Show>
    {/* 原生文本合成在「宽字符行恰好占满可用宽」时会把相邻兄弟文本行内续排（24 列可复现，
        与卡片布局无关）；gap 强制三行金额独立成行，保证任意宽度下「分别一行」成立。 */}
    <box flexDirection="column" gap={1}>
      <text fg={props.theme.text}>今日 {formatUsd(spend().today)}</text>
      <text fg={props.theme.text}>本周 {formatUsd(spend().week)}</text>
      <text fg={props.theme.text}>本月 {formatUsd(spend().month)}</text>
    </box>
    <Show when={props.details}><text fg={props.theme.text}>累计 {formatUsd(spend().total)}</text></Show>
    <Show when={props.details}><text fg={props.theme.textMuted}>本地更新：{formatTime(spend().updatedAt)}</text></Show>
  </box>;
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
    <box id="quota-sidebar-title" flexDirection="row" onMouseDown={() => setCollapsed((value) => !value)}>
      <text fg={props.theme.text}>{collapsed() ? "Quota ▸" : "Quota ▾"}</text>
    </box>
    <Show when={!collapsed()}>
      <LocalStatus state={props.state} theme={props.theme} />
      <Show when={props.state().localStatus.phase === "ready" && channels().length === 0}><text fg={props.theme.textMuted}>尚未连接支持的渠道</text></Show>
      <For each={channels()}>{(channel) => <box flexDirection="column" flexShrink={0}>
        <ChannelBlock channel={channel} theme={props.theme} now={props.state().now} />
      </box>}</For>
    </Show>
    <Show when={collapsed() && alerting()}>
      <LocalStatus state={props.state} theme={props.theme} />
    </Show>
  </box>;
}
