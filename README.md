# OpenCode Quota

面向 **Linux / OpenCode 1.x（实测 1.18.30/1.18.31） / 标准本地 TUI** 的只读额度插件。自包含、无本机路径依赖，可整体迁移到其他 Linux 机器。交付验收状态见 [验收说明](docs/acceptance.md)；类型检查或模拟界面不代表真实供应商认证已通过。

## 功能

- 会话侧边栏自动显示 GLMCodingPlan、GPT Pro20x 订阅窗口及 DeepSeek 余额；消费估算等完整信息在 `/quota` 明细查看。
- Quota追加在原生Context/MCP/LSP/Todo/Modified Files之后；订阅额度用水平字符进度条（█填充+░底，宽16）配百分比与重置倒计时，进度由填充长度编码，黑白可读。点击 Quota 标题行可折叠/展开（▾/▸），折叠状态进程内保持。
- 侧栏标题为Quota，隐藏正常“已更新”、远端/本地更新时间、套餐、DeepSeek消费区与命令提示行；`/quota`明细保留全部诊断与消费信息。缓存/过期、认证错误、部分统计等必要异常提示不会被隐藏。
- `/quota` 打开可滚动明细，Esc 关闭；`/quota-refresh` 重新识别凭据、刷新远端和校准本地统计，均为本地命令，不发送模型 prompt。
- 启动与每 15 分钟刷新，独立展示缓存、陈旧、错误与未连接状态。失败不冒充零余额，倒计时归零不自动清空已用额度。
- 国际 GLM 不支持也不显示；DeepSeek 本地估算不是供应商账单，不包含其他应用消费。

## 安装与卸载

1. 将本仓库放到**长期保留的绝对路径**，在该目录执行 `npm ci`。Node/npm 用于安装锁定开发依赖，Bun 由项目内依赖提供，无需全局安装。
2. 执行 `npm run typecheck`。分发的是源码，没有 `dist`；不要以 npm 包名加载源 TSX，也不要打包另一份 Solid/OpenTUI 运行时。
3. 在自己的 `tui.json`（默认 `~/.config/opencode/tui.json`，自定义 XDG 时相应调整）根级 **追加** 插件项，保留原有 plugin 与其他设置。例如：

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["file:///<本仓库在你机器上的绝对路径>/src/tui.tsx"]
   }
   ```

   上例是结构示例，不要直接覆盖已有文件。入口必须是 `src/tui.tsx`，**不得安装 `tests/smoke/entry.tsx`**。源码目录及其 `node_modules` 必须一直保留，不要指向将被清理的临时目录。

## 迁移到新机器

要求：Linux、OpenCode 1.x（标准本地 TUI）、Node.js + npm（仅用于 `npm ci` 装依赖；Bun 由项目内 devDependency 提供，无需全局安装）。

1. 用任一方式把仓库整体搬到新机器的长期路径：`git clone <你的远端>`、拷贝整个目录（可先删 `node_modules/` 与 `test-fence-reports/`），或使用单文件包 `git bundle create opencode-quota.bundle develop` 后 `git clone opencode-quota.bundle opencode-quota`。
2. 在仓库目录执行 `npm ci`，然后 `npm run typecheck` 确认完整。
3. 按上一节配置新机器的 `tui.json`（file URL 指向新绝对路径），重启 OpenCode。
4. 凭据无需迁移：插件复用新机器宿主已连接的 provider（GLM Coding Plan Key / DeepSeek Key / OpenAI OAuth），用 `/connect` 完成连接即可；本地消费统计按新机器自己的历史计算。
4. **退出并重启 OpenCode**，用默认本地模式打开会话并显示侧边栏（宿主默认快捷键 `<leader>b`）。无需填写插件选项或另存 Key；使用宿主已有连接。

卸载：移除对应 plugin 项，退出并重启。不要删除宿主 auth 或数据库。可选清理插件自己的 `$XDG_STATE_HOME/opencode/channel-quota`（缺省 `~/.local/state/opencode/channel-quota`）缓存。

## 支持边界与安全

- 不支持 attach、显式网络 transport、其他宿主版本、自定义代理域/第三方认证接管。无法确认本地环境时不读取凭据或数据库。
- 凭据只读，不刷新 OAuth、不写宿主认证，不发送 `/responses` 或其他模型探针。OAuth 过期请通过宿主重新认证；API Key 变更可能需要重启宿主才能生效。
- 本地数据库在独立 Worker 中只读；按 DeepSeek assistant 消息的最新累计 `cost`、创建时间和现存记录统计。包括归档/子代理；删除会减少估算，fork 复制历史可能使估算偏高；换 Key 不分账。
- 远端保留原币种，不换汇；本地 USD 基于宿主价格，零成本不证明实际零扣费。
- 更多路径、数据库多发行渠道冲突、非公开 API 限制见 [兼容说明](docs/compatibility.md)。

## 开发与验证

```bash
npm run typecheck
npm run test:unit -- tests/unit tests/ui   # 核心tc：12个（解析/凭据/聚合/挂载渲染）
# 以下仅由收尾调度者统一执行：
npm run smoke -- --opencode /绝对路径/opencode
npm run fence -- --opencode /绝对路径/opencode
```

smoke 需要 Linux、tmux、目标版本真实可执行文件；不安装这些系统工具，不读真实账号。脚本参数、隔离策略、产物及失败语义见 [验收说明](docs/acceptance.md)。`npm run build` 等同类型检查；`npm test` 是剩余核心 unit/UI，`fence` 顺序包含 build、核心测试和真实宿主的合成凭据 smoke。按用户决策测试已瘦身至核心集。

## 发布说明（如需公开分发）

- 当前分发形态为 **TSX 源码 + file URL**（宿主 Bun 即时编译）。若要发布到 npm 供 `plugin: ["<包名>"]` 一行安装，需先增加 **TSX 预编译产物**（构建出 `dist/*.js` 并在 package.json 指向），因为宿主从 npm 缓存加载时对源 TSX 的转译行为与本地 file URL 不同——这是发布前的主要开发工作。
- OpenCode 官方社区列表（opencode.ai/docs/ecosystem）通过向 `anomalyco/opencode` 仓库提 PR 添加条目，维护者人工审核，免费；npm 发布亦免费，需 npm 账号，无人工审核。
- 本插件读取宿主凭据与本地数据库（只读），公开分发时 README 的安全边界说明（见"支持边界与安全"）就是用户信任的核心材料。
