# 兼容性与数据口径

## 锁定环境

仅面向 Linux、OpenCode **1.x（已实测 1.18.30/1.18.31）**、默认本地 TUI。实现参照 [v1.18.30 源码（版本门放宽为 1.*.*，实测 1.18.31 通过）](https://github.com/anomalyco/opencode/tree/v1.18.30)，不承诺其他版本、发行渠道或 attach/显式网络模式。运行验证状态必须查阅验收产物，不能由本表推定通过。

| 依赖 | 精确开发版本 |
|---|---|
| `@opencode-ai/plugin` / `@opencode-ai/sdk` | 1.18.30 |
| `@opentui/core` / `solid` / `keymap` | 0.4.5 |
| `solid-js` | 1.9.12 |
| TypeScript | 5.8.2 |
| `@types/bun` / 项目内 Bun | 1.3.13 / 1.3.14 |

Node 24.19.0 / npm 11.17.0 为准备环境。通过 file URL 分发 `src/tui.tsx`，由宿主编译并提供运行时；不能直接以 npm 包名安装 TSX 源码。`build` 不生成 dist。第三方声明存在 EventEmitter/TextEncoder 冲突，`skipLibCheck:true` 不关闭 src/tests/scripts 的 strict 检查，也不证明 Solid 身份或原生依赖兼容。

## 宿主与路径

- 仅受限读取 SDK `client.getConfig().baseUrl`，必须精确为 `http://opencode.internal`，再验证 health 版本。localhost 不是本地证明；检查失败不启动认证读取、远端请求或数据库 Worker。
- data = 绝对 `$XDG_DATA_HOME/opencode`，缺省 `~/.local/share/opencode`。宿主 `/path` 的 `state` **不是**数据库目录；相对/空的显式 XDG 值拒绝猜测。
- DB 使用宿主 `OPENCODE_DB`；相对值相对 data 目录。缺省只接受标准 `opencode.db`；若目录内有其他 `opencode*.db` 与之并存，或只有非标准库，报告 `database_ambiguous`。请在启动宿主时明确 `OPENCODE_DB`，插件不会逐库扫描并猜活跃库。拒绝内存库、非普通文件和未知 schema。
- 缓存 = 绝对 `$XDG_STATE_HOME/opencode/channel-quota`，缺省 `~/.local/state/opencode/channel-quota`。仅安全快照，身份 SHA-256 隔离，目录 0700/文件 0600，最长 7 天。多个本地 TUI 各自调度，不共享累计账本。

## 渠道与认证

| 渠道 | 支持 | 限制 |
|---|---|---|
| 国内 GLM | `zhipuai-coding-plan`，宿主生效 API Key | 仅 `open.bigmodel.cn`，不包含普通 zhipuai 或国际 GLM |
| OpenAI | connected openai + 本地有效原生 OAuth + accountId | API Key/wellknown 不支持订阅额度；原生 OAuth-only 的 `source=custom` 本身不是拒绝理由 |
| DeepSeek | `deepseek`，宿主生效 API Key | 仅 `api.deepseek.com`；余额币种独立保留 |

GLM/DeepSeek 的 custom 来源、非官方模型/baseURL 或不同模型认证覆盖拒绝；OpenAI 同样不能借 custom 来源绕过 OAuth/官方端点限制。无环境变量兜底试 Key。API Key 更新但宿主快照未更新时隐藏旧身份并提示重启，不使用新文件 Key 冒充生效连接。OAuth 只读取 access/expires/accountId；过期不主动 refresh，也不通过模型调用触发宿主刷新。

国内 GLM monitor 与 OpenAI wham 是非公开稳定契约；GLM unit=3/6 的 5 小时/周映射来自社区调研，**未用真实账号验证**。未知字段保守降级，未知窗口不冒充 5 小时；不以失败或缺失数据解释为无限/零。只 GET，不伪装 UA，不调用 `/responses`、`/oauth/token` 或其他 token 探针。

## 本地消费不是账单

- 只读 v1 `message` 元数据，不改 schema，不读 part/正文，不切换到缺少完整历史的 `session_message`。
- DeepSeek assistant 的 `cost` 是消息最新累计 USD 值；逐 id 覆盖，包含现存的所有项目、主/子代理与归档会话。中断/错误消息的合法部分费用照计。
- 按消息创建时间进入本地时区的日/月与周一开始的周；续聊更新旧消息不会移到今天。使用日历边界处理 DST，不能减固定 24 小时。
- 删除消息/会话会减少估算；fork 复制为新 id 的旧历史会重复计入，可能偏高，不做启发式扣重。换 Key 不分账，不含其他应用。
- 缺失/坏 JSON/非法 cost/孤儿行等标部分统计，不伪装零；已知零不证明供应商实际未扣费。自定义价格必须为 USD。金额聚合后格式化，非零小额可达 6 位。
- 远端额度、余额、本地消费各有更新时间，不换汇、不互相推导。事件更新约 500ms 起批，15 分钟/手动全量校准修复跨进程或丢事件；30 秒 tick 更新倒计时与日期桶，不联网、不清空远端百分比。
