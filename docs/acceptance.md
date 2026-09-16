# 验收说明与操作手册

## 状态与证据边界

2026-09-14展示反馈迭代已完成：原生区块优先、Quota底部、水平字符进度条（█/░，填充长度编码进度）、点击折叠/展开、渠道名GLM  Coding  Plan/GPT Pro20x/DeepSeek。按用户指令测试清理至核心12个tc（解析4/凭据3/聚合3/UI2），验证为typecheck、12/12通过与单次现有smoke(smoke-2SbmkR)11项PASS。本节记录当前迭代的验证，旧版报告仅作为历史证据保留。

本文件描述可复现的验收方法，**不是预先签发的 PASS 证明**。B4 实现阶段仅执行 `npm run typecheck`；不执行全量测试、真实宿主 smoke 或 fence。B0–B3 分块测试由对应构建任务报告，本轮不重复执行。

- B4 最小自验：2026-09-13 `npm run typecheck` 通过（含 scripts 与 smoke 入口）；不构成运行时挂载证明。
- 最终全量unit/UI：**106/106通过，0失败**，含点阵位序/渲染字符域、原生排序、窄屏卡片、精简与详情分流回归；build通过。质量复审仅新增测试断言、生产代码不变，追加单UI文件复验11/11通过（1647断言），按规则不重复全量fence。
- OpenCode 1.18.31真实宿主+合成凭据+mock供应商smoke：**11项检查全部PASS**（smoke-KGJVBx，含真实侧栏、命令、会话切换、42/24列滚动、零新增消息、安全审计与退出码；1.18.30历史证据smoke-RFVmg6等同）。
- 最新完整fence与Checker质量门revision5均PASS，工作流DONE。历史证据随项目迁移至本目录 `test-fence-reports/`：`fence-qpGcmH/summary.txt`、`smoke-MPfxwR/summary.txt`（点阵环版本实拍，后续水平条版本见`smoke-2SbmkR`）。质量报告位于workbench `.specpipe/reviews/opencode-channel-quota-quality-gate-revision-5.md`；此前revision3等报告保留为历史。
- 真实GLM/OpenAI/DeepSeek查询：2026-09-14用户单独授权安装和联调，复用现有连接的三个官方GET均200，无模型生成/OAuth刷新；记录仅含成功状态与字段结构，不保存个人额度、余额或凭据。GLM实测为CREDIT_LIMIT+unit/number，与旧TOKENS_LIMIT不同，已补兼容及两项回归并通过完整复验。**自动fence仍只用mock，不自动重复真实请求；日志中的“未授权”专指自动fence的真实查询权限，不否定这次独立联调授权**。
- 交付质量门须 Checker 与本轮 fence 双 PASS。任何未运行、依赖缺失、超时、挂载失败、字段不匹配或泄露都是阻塞，不允许删减验收后宣称通过。

## 命令和依赖

从长期保留的源码仓库根目录运行，先按 lock 执行 `npm ci`。Node/npm、项目内 Bun 为已有依赖；额外运行工具仅为 Linux 的 **tmux 与 `/usr/bin/env`**，以及目标 OpenCode 1.x.y 可执行文件。不安装全局 Bun，不自动安装宿主/tmux，不修改真实配置。

```bash
npm run typecheck
# Oracle 收尾统一运行（不在单块开发中重复执行）：
npm run smoke -- --opencode /绝对路径/opencode
npm run fence -- --opencode /绝对路径/opencode
```

`--opencode` 可省略，此时只从 PATH 找 `opencode`；找不到即非零失败，不读取用户配置来猜路径。传入时必须使用绝对路径。不接收 Key、auth 文件、DB 路径或 mock 开关参数。`/tmp/opencode` 必须已存在并为普通真实目录。

fence 顺序运行 `npm run build`（180 秒预算）、`npm test`（300 秒）、`bun scripts/smoke.ts`（300 秒）。前置失败时后续明确 `NOT_RUN`，最终非零；smoke 超时先 SIGTERM 并留 15 秒清理，再强制结束，强制结束仍是失败。Oracle 可在自己的独立 tmux 后台运行该命令；后台会话不等于 smoke 内部 PTY，两者各自管理。

## smoke 的实际流程

1. 在 `/tmp/opencode/channel-quota-smoke-<随机>` 下创建 home/config/data/state/cache/project/tmp，权限 0700；合成配置权限 0600。除脱敏报告外，所有运行写入限此目录。
2. **allowlist 重建**子进程环境：PATH、固定 UTF-8 locale/TERM、临时 HOME/OPENCODE_TEST_HOME、四个 XDG、TMPDIR、固定 SHELL；仅增加测试生成的认证内容与隔离/禁更新/禁模型目录联网参数。绝不展开父进程全部 env，不继承 provider Key、SSH、OPENCODE_CONFIG* 等变量。额外的 DeepSeek env 来源仅传入脚本内合成 Key。不设 OPENCODE_PURE，不屏蔽原生 OpenAI loader。
3. 在临时全局配置声明唯一测试插件的 file URL；模型目录也是脚本生成的三渠道小型夹具，不读取真实模型缓存、不联网更新目录。通过隔离 serve 的 `/provider` 验证 GLM config、DeepSeek env/api、OpenAI OAuth-only custom/dummy 的有效返回。切换 env/api 使用重新启动的 serve，不伪造 provider.list。
4. 同环境 loopback `POST /session` 创建 Alpha/Beta 两个会话，不调用 prompt。关闭 serve 后仅向临时宿主已初始化的 v1 `message` 插入两条 assistant 元数据，合计 USD 0.75。主测试从不自行创建假宿主 schema。
5. 独立随机 **tmux socket**，禁读用户tmux配置；`env -i`再次隔离，透明子进程包装器启动真实宿主。160×80会话界面无需命令自动显示三渠道、点阵环和日/周/月USD 0.75；准备阶段额外向临时todo表插入合成待办，真实帧断言Context/Todo位于Quota上方、侧栏无正常状态与更新时间冗余。stdin/stdout/stderr继承PTY，不使用管道prompt。
6. 仅当slash自动完成出现对应本地命令标题，或窄屏有左右边框的对应菜单行，才提交 `/quota`、`/quota-refresh`；输入框自身不算建议证据。检查生产详情、累计/统计口径、Esc、刷新每渠道恰好一次额外GET。
7. 使用临时tui.json绑定F6侧栏、F7会话列表、F8深浅主题、F10退出；切到Beta、隐藏/恢复侧栏、切换主题，在终端42/24列打开真实详情，用方向键到底、Esc关闭、恢复宽屏。tmux发送PgDn的序列在当前宿主表现不同，真实PTY验收只声明方向键通过；PgDn/PgUp仅有组件测试证据。绑定不替换插件组件或controller。
8. 正常退出码必须为零且无终止信号。tmux 3.2a无pane_dead_status，采用透明包装器记录真实子进程exitCode/signalCode，不能把空值当零。只读重开临时DB，对比两代消息表签名，确认无新增或修改消息。mock必须只有三类官方GET各两次；其他请求拒绝，无/oauth/token、/responses或模型探针。
9. 扫描真实捕获画面、隔离宿主日志和插件缓存中的合成 secret/account sentinel。发现泄露即 FAIL；持久化报告先脱敏，**脱敏不是放行**。不保存原始 provider.list、配置、auth、DB 或完整 headers。
10. 清理本次 serve PID 与本次随机 tmux socket；不调用 `pkill opencode`、不碰其他 tmux。删除前验证 `/tmp/opencode` 前缀、realpath 与 uid。清理无法确认则 FAIL，保留目录供 Oracle 定向处理。

测试入口只调用 `createQuotaPlugin({fetch: mockFetch})`，**保留生产 Sidebar/Details/controller/宿主绑定/凭据读取/真实 Worker/SQLite**。没有全局 fetch monkeypatch、伪造宿主 API、手画界面或正常用户可开启的 mock 配置。进程隔离防止访问真实用户 auth/DB/config；它不是 syscall 跟踪工具或通用网络沙箱，不将环境隔离说成操作系统级取证。

## 产物与失败处理

- 独立 smoke：`test-fence-reports/smoke-<随机>/summary.txt`、依赖/来源契约说明、请求静态审计、消息零变更结论、脱敏宿主日志/插件缓存，以及真实 `capture-pane` 的 `.txt`/带颜色 `.ansi`。
- 截图是终端真实文本帧，不生成或声称有 PNG。失败时尽量保存最后真实帧；无法捕获就没有画面，不绘制替代图。
- fence：`test-fence-reports/fence-<随机>/{build,unit-ui,smoke}.log` 和本轮 summary；根 `test-fence-reports/summary.txt` 原子更新，列目标版本、各项退出码/耗时/PASS/FAIL/未运行原因。运行中是 RUNNING，不沿用旧 PASS。smoke 日志给出对应独立报告目录。
- 报告仅证明当次执行的环境。旧报告不能证明新改动；不能只看到 mock GET 成功便忽略 Worker、UI、退出码或安全检查失败。
- 若宿主迁移 schema、TSX/原生依赖或 Solid 身份加载失败、provider.list 来源与锁版契约不符，交 Oracle 协调任务书/环境，不通过替换生产组件、伪造 DB 或跳过步骤“修复”。

## 自动化回归覆盖定位

| 领域 | 保留的核心测试（用户决策：小插件只留核心tc） |
|---|---|
| 三渠道解析（GLM CREDIT_LIMIT/OpenAI窗口/DeepSeek币种） | `tests/unit/quota-parsers.test.ts`（4） |
| 凭据优先级/OAuth只读/过期不请求 | `tests/unit/credentials.test.ts`（3） |
| 消费聚合归属/时区周期/fork | `tests/unit/spend-aggregate.test.ts`（3） |
| 插件注册与侧栏渲染（水平条/折叠/渠道名/详情） | `tests/ui/quota.test.tsx`（2） |

2026-09-14按用户指令删除了其余9个细粒度unit文件与多余UI用例（http细节/缓存/服务调度/runtime/路径/reader/Worker性能/契约/format），历史版本见workbench工作流档案与git历史。真实联调授权不改写自动验收的mock属性；后续新增真实验证仍应另记授权范围、日期与脱敏证据。
