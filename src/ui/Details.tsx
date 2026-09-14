/** @jsxImportSource @opentui/solid */
import { For } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { PROVIDER_IDS } from "../core/contracts.ts";
import { ChannelBlock, LocalStatus, SpendBlock, type ViewProps } from "./Sidebar.tsx";
import { formatTime } from "./format.ts";

export function Details(props: ViewProps) {
  const dimensions = useTerminalDimensions();
  // 宿主弹窗父容器为自动高度：扣除顶部四分之一留白、内边距一行与底部一行。
  const height = () => Math.max(1, dimensions().height - Math.ceil(dimensions().height / 4) - 2);
  const channels = () => PROVIDER_IDS.flatMap((id) => props.state().channels.filter((channel) => channel.providerId === id));
  return <box id="quota-details" flexDirection="column" height={height()} flexShrink={0} width="100%" paddingX={1}>
    <text flexShrink={0} fg={props.theme.text}>Quota 与本地消费</text>
    <text flexShrink={0} fg={props.theme.textMuted}>Esc 关闭 · ↑↓ 滚动</text>
    <scrollbox id="quota-details-scroll" focused minHeight={0} flexGrow={1} flexShrink={1} scrollX={false} contentOptions={{ flexDirection: "column", gap: 1, paddingRight: 1 }}>
      <LocalStatus state={props.state} theme={props.theme} />
      <For each={channels()}>{(channel) => <ChannelBlock channel={channel} theme={props.theme} now={props.state().now} details />}</For>
      <text fg={props.theme.text}>DeepSeek 本地估算</text>
      <SpendBlock state={props.state} theme={props.theme} details />
      <box flexDirection="column" flexShrink={0}>
        <text fg={props.theme.textMuted}>时区：{props.state().spend.timezone}；每周一开始</text>
        <text fg={props.theme.textMuted}>日起点：{formatTime(props.state().spend.periodStart.day)}</text>
        <text fg={props.theme.textMuted}>周起点：{formatTime(props.state().spend.periodStart.week)}</text>
        <text fg={props.theme.textMuted}>月起点：{formatTime(props.state().spend.periodStart.month)}</text>
        <text fg={props.theme.textMuted}>有效 {props.state().spend.validCount} · 无效 {props.state().spend.invalidCount} · 未知 {props.state().spend.unknownCount} · 零成本 {props.state().spend.zeroCount}</text>
      </box>
      <text fg={props.theme.warning} wrapMode="word">按创建时间统计现存记录，包含归档/子代理，不区分换 Key，不含其他应用。宿主自定义价格须为 USD；零成本并不证明零扣费。fork 复制历史可能使估算偏高。</text>
      <text fg={props.theme.textMuted} wrapMode="word">远端余额/额度与本地消费分别更新，不混合币种或换算汇率。本地消费是估算，不是供应商账单。到达重置时间不会自动将已用额度清零。</text>
    </scrollbox>
  </box>;
}
