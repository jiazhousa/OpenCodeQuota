# OpenCode Quota 开发约定

## 模块职责

- `src/core/contracts.ts`：三渠道、脱敏状态、错误、Clock 与服务端口的公共契约；跨块修改先交调度者协调。
- `src/providers/`：宿主有效凭据解析、官方 GET、解析器、身份隔离缓存、重试与刷新调度。不得把原始 auth/Provider/HTTP 异常传到 UI。
- `src/spend/`：路径判定、Worker RPC、只读 SQLite 元数据读取与按消息 id 聚合。主线程不扫描数据库；不迁移或修改宿主库。
- `src/runtime/`：锁版/本地验证、事件投影与控制器生命周期。
- `src/ui/`、`src/tui.tsx`：生产侧栏/滚动详情、命令和宿主挂载；只消费安全快照，使用宿主 Solid/OpenTUI 身份。
- `tests/`：合成夹具、单元与渲染测试；`tests/smoke/entry.tsx` 只替换生产 factory 的远端 fetch，禁止正常安装。
- `scripts/`：无真实凭据 smoke 与统一 fence，失败不跳过、不伪造界面。

## 最小验证

- 所有源码/测试/脚本变更：`npm run typecheck`。
- 按改动块追加：`npm run test:unit -- tests/unit/<对应文件>.test.ts`；UI 对应 `tests/ui/quota.test.tsx`。
- 不自行扩大到全量/E2E/fence；由 Oracle 统一运行 `npm run fence -- --opencode /绝对路径/opencode`，核对 `test-fence-reports/summary.txt`。
- 注释与文档中文；保留已有注释。无授权不 commit/push、不改全局配置、不读真实 auth/DB/config、不发真实供应商请求。
- 固定依赖与 file URL 源码分发；不自行升级版本、引入依赖或打包第二套运行时。`skipLibCheck` 仅屏蔽第三方声明冲突，不能当作真实挂载验证。

唯一任务书与工作流档案位于 `/home/starlex/project/workbench/.specpipe/plans/opencode-channel-quota/`；兼容与验收限制分别见 `docs/compatibility.md`、`docs/acceptance.md`。2026-09-14用户已单独授权本次安装和真实GET联调；真实查询始终不属于自动fence，后续代理不得将本次授权扩大为任意凭据读取/模型请求或永久联调授权。
