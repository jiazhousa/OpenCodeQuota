// smoke 专用 CLI 侧插件入口（V2 双侧架构，2.0.16）：
// 渲染链路与生产完全一致（src/tui.tsx 直转发）——数据层 mock 在 server 侧入口（tests/smoke/server-entry.ts）。
export { default } from "../../src/tui.tsx";
