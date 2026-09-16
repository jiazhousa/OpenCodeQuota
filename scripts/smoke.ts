import { Database } from "bun:sqlite";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
// 目标宿主版本在"依赖与目标版本"步骤内由 command()（带超时与退出码处理）动态探测赋值；
// 不在顶层裸 spawn：宿主后台进程可能持有 stdout 使 text() 永久等待。
const sentinels = ["synthetic-quota-glm-secret", "synthetic-quota-deepseek-secret", "synthetic-quota-openai-access",
  "synthetic-quota-account-id", "synthetic-quota-refresh-never-use"];
const checks = new Map<string, string>([
  ["依赖与目标版本", "NOT_RUN"], ["config/auth/env 与原生 OAuth provider.list", "NOT_RUN"],
  ["宿主建会话与合成 DB", "NOT_RUN"], ["真实 PTY 自动侧栏", "NOT_RUN"],
  ["quota-refresh 三渠道 GET", "NOT_RUN"],
  ["切换会话与隐藏侧栏", "NOT_RUN"], ["深浅主题与窄屏恢复", "NOT_RUN"],
  ["正常退出与零新增消息", "NOT_RUN"], ["安全日志/缓存/请求审计", "NOT_RUN"], ["清理", "NOT_RUN"],
]);
class SmokeFailure extends Error {}
function requireThat(condition: unknown, label: string): asserts condition {
  if (!condition) throw new SmokeFailure(label);
}
const cancellation = new AbortController();
const interrupt = () => cancellation.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
let root = "";
let report = "";
let tmux = "";
let socket = "";
let tmuxStarted = false;
let env: Record<string, string> = {};
let activeCheck = "依赖与目标版本";
let leaked = false;
let failed = false;
let reason = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
const serverOutputs: string[] = [];
const serverDrains: Promise<void>[] = [];
let observedVersion = "NOT_RUN";
let targetVersion = "NOT_RUN";
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// 所有异常对外只使用静态说明；合成密钥出现在产物也必须失败，脱敏不把失败变成成功。
function redact(text: string): string {
  for (const sentinel of sentinels) {
    if (text.includes(sentinel)) leaked = true;
    text = text.replaceAll(sentinel, "[REDACTED]");
  }
  return text;
}
async function artifact(name: string, text: string): Promise<void> {
  await writeFile(join(report, name), redact(text), { mode: 0o600 });
}
async function step(name: string, action: () => Promise<void>) {
  activeCheck = name;
  checks.set(name, "RUNNING");
  await action();
  checks.set(name, "PASS");
}
async function until(probe: () => Promise<boolean>, label: string, timeout = 15000) {
  const end = Date.now() + timeout;
  do {
    requireThat(!cancellation.signal.aborted, "收到中止信号");
    if (await probe()) return;
    await sleep(150);
  } while (Date.now() < end);
  throw new SmokeFailure(label);
}
async function stop(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([child.exited, sleep(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
}
async function command(args: string[], commandEnv = env, timeout = 15000) {
  const child = Bun.spawn(args, { cwd: root || repository, env: commandEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, timeout);
  try {
    const code = await child.exited;
    return { code, stdout: await stdout, stderr: await stderr, expired };
  } finally { clearTimeout(timer); }
}
async function tm(...args: string[]): Promise<string> {
  const result = await command([tmux, "-S", socket, "-f", "/dev/null", ...args]);
  requireThat(result.code === 0 && !result.expired, "tmux 操作失败（依赖、PTY 或宿主已退出）");
  return result.stdout;
}
async function keys(...args: string[]) { await tm("send-keys", "-t", "quota:0.0", ...args); }
async function screen() { return tm("capture-pane", "-p", "-t", "quota:0.0"); }
const contains = (text: string, part: string) => text.replace(/\s/g, "").includes(part.replace(/\s/g, ""));
// 标题 Quota 与合成会话名「Quota Smoke …」前缀冲突：标题证据只认 trim 后整行 Quota+折叠标记（▾/▸），禁止全局 contains("Quota")。
const hasQuotaTitle = (text: string) => text.split("\n").some((line) => /^Quota [▾▸]$/.test(line.trim()));
const colors = (ansi: string) => JSON.stringify([...new Set(ansi.match(/\x1b\[[\d;]*m/g) ?? [])].sort());
async function capture(name: string) {
  await artifact(`${name}.txt`, await screen());
  await artifact(`${name}.ansi`, await tm("capture-pane", "-p", "-e", "-t", "quota:0.0"));
}
async function visible(parts: string[], label: string, timeout?: number) {
  await until(async () => {
    const text = await screen();
    return parts.every((part) => contains(text, part));
  }, label, timeout);
}
async function slash(name: "quota-refresh") {
  await keys("-l", `/${name}`);
  // 确认是已注册的本地 slash 建议才按 Enter，避免未知命令变为用户 prompt。
  await until(async () => {
    const text = await screen();
    // 窄屏宿主会隐藏建议说明；要求命令在有左右边框的菜单行中，不能把输入框自身当建议。
    const menuRow = new RegExp(`^\\s*┃\\s*/${name}\\s+.*┃\\s*$`);
    return contains(text, "Refresh Quota") || text.split("\n").some((line) => menuRow.test(line));
  }, "未出现本地 slash 建议，拒绝提交输入");
  await keys("Enter");
}
async function requests(): Promise<Array<{ kind: string; method: string; at: number }>> {
  const text = await readFile(join(root, "requests.ndjson"), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > 4 * 1024 * 1024) { cancellation.abort(); break; }
    serverOutputs.push(decoder.decode(item.value, { stream: true }));
  }
  serverOutputs.push(decoder.decode());
}
async function startServer(binary: string, serverEnv: Record<string, string>) {
  const start = serverOutputs.length;
  const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: join(root, "project"), env: serverEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  server = child;
  serverDrains.push(drain(child.stdout), drain(child.stderr));
  let address = "";
  await until(async () => {
    requireThat(child.exitCode === null, "隔离 serve 提前退出");
    address = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(serverOutputs.slice(start).join(""))?.[1] ?? "";
    return Boolean(address);
  }, "隔离 serve 未在 30 秒内就绪", 30000);
  return async (path: "/provider" | "/session" | "/global/health", body?: object): Promise<unknown> => {
    requireThat(/^http:\/\/127\.0\.0\.1:\d+$/.test(address), "拒绝非 loopback 准备请求");
    const response = await fetch(address + path, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(15000)]),
      headers: { "content-type": "application/json", "x-opencode-directory": join(root, "project") },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    requireThat(response.ok, "隔离宿主 API 返回失败");
    return response.json();
  };
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
function providerContract(data: unknown, deepseekSource: "env" | "api") {
  requireThat(record(data) && Array.isArray(data.all) && Array.isArray(data.connected), "provider.list 数据结构不匹配");
  const expected = [
    { id: "zhipuai-coding-plan", source: "config", key: sentinels[0] },
    { id: "deepseek", source: deepseekSource, key: sentinels[1] },
    { id: "openai", source: "custom", key: "opencode-oauth-dummy-key" },
  ];
  for (const item of expected) {
    const found: unknown = data.all.find((provider: unknown) => record(provider) && provider.id === item.id);
    requireThat(data.connected.includes(item.id) && record(found) && found.source === item.source, "provider.list 连接或来源不匹配");
    const options = record(found.options) ? found.options : {};
    const key = Object.hasOwn(options, "apiKey") ? options.apiKey : found.key;
    requireThat(key === item.key && record(found.models) && Object.keys(found.models).length > 0, "provider.list 有效凭据或模型不匹配");
  }
}
function dbRows(db: Database) {
  // 只读取隔离库的消息签名；两代消息表都核验，避免宿主将意外 prompt 写入新表而漏检。
  return JSON.stringify({
    old: db.query("SELECT id, session_id, time_created, time_updated, data FROM message ORDER BY id").all(),
    current: db.query("SELECT id, session_id, type, seq, data FROM session_message ORDER BY id").all(),
  });
}
async function safeDirectory(path: string) {
  const info = await lstat(path);
  requireThat(info.isDirectory() && !info.isSymbolicLink() && await realpath(path) === path, "目录不是独立的普通目录");
}
async function scanSafeFiles(directory: string, prefix: string): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (record(error) && error.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    requireThat(!entry.isSymbolicLink(), "安全产物目录出现符号链接");
    const path = join(directory, entry.name);
    const name = `${prefix}-${entry.name}`;
    if (entry.isDirectory()) { await scanSafeFiles(path, name); continue; }
    requireThat(entry.isFile() && (await lstat(path)).size <= 4 * 1024 * 1024, "安全产物不是有界普通文件");
    await artifact(name.replace(/[^\w.-]/g, "_"), await readFile(path, "utf8"));
  }
}

try {
  requireThat(process.platform === "linux", "smoke 仅支持 Linux");
  await safeDirectory("/tmp/opencode");
  root = await mkdtemp("/tmp/opencode/channel-quota-smoke-");
  const reports = resolve(repository, "test-fence-reports");
  await mkdir(reports, { recursive: true, mode: 0o700 });
  await safeDirectory(reports);
  report = await mkdtemp(join(reports, "smoke-"));
  for (const name of ["home", "config", "data", "state", "cache", "project", "tmp"]) {
    await mkdir(join(root, name), { mode: 0o700 });
  }
  await mkdir(join(root, "config/opencode"), { mode: 0o700 });
  await writeFile(join(root, "requests.ndjson"), "", { mode: 0o600 });
  // 不展开 process.env：宿主只获得固定 allowlist 与本脚本生成的合成输入。
  env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    HOME: join(root, "home"), OPENCODE_TEST_HOME: join(root, "home"), SHELL: "/bin/sh",
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), TMPDIR: join(root, "tmp"),
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_MODELS_PATH: join(root, "models.json"),
  };
  const auth = { openai: { type: "oauth", access: sentinels[2], accountId: sentinels[3], refresh: sentinels[4], expires: Date.now() + 86400000 } };
  env.OPENCODE_AUTH_CONTENT = JSON.stringify({ ...auth, deepseek: { type: "api", key: sentinels[1] } });
  await artifact("environment-policy.txt", `仅以下变量由脚本构造并传入子进程（不保存认证值）：\n${Object.keys(env).sort().join("\n")}\nDeepSeek env 验证阶段另加脚本内合成 DEEPSEEK_API_KEY。\nOPENCODE_PURE、父进程 OPENCODE_CONFIG*、SSH 和供应商环境均未继承。\n`);
  const args = process.argv.slice(2);
  requireThat(args.length === 0 || (args.length === 2 && args[0] === "--opencode"), "用法：npm run smoke -- --opencode /绝对路径/opencode");
  const binary = args[1] ?? Bun.which("opencode", { PATH: env.PATH });
  await step("依赖与目标版本", async () => {
    requireThat(binary && isAbsolute(binary), "缺少 OpenCode 可执行文件；请传 --opencode 绝对路径");
    tmux = Bun.which("tmux", { PATH: env.PATH }) ?? "";
    requireThat(tmux && Bun.which("env", { PATH: "/usr/bin:/bin" }), "缺少 tmux 或系统 env");
    const version = await command([binary, "--version"]);
    observedVersion = version.stdout.trim();
    targetVersion = observedVersion;
    requireThat(version.code === 0 && /^1\.\d+\.\d+$/.test(observedVersion), "目标宿主必须是 1.x.y 且可执行");
    const tmuxVersion = await command([tmux, "-V"]);
    requireThat(tmuxVersion.code === 0, "tmux 不可用");
    await artifact("dependencies.txt", `opencode=${observedVersion}\n${tmuxVersion.stdout}`);
  });
  requireThat(binary, "缺少 OpenCode");
  const model = (id: string) => ({ id, name: id, release_date: "2026-01-01", attachment: false, reasoning: false,
    temperature: true, tool_call: true, cost: { input: 1, output: 1 }, limit: { context: 128000, output: 4096 } });
  await writeFile(env.OPENCODE_MODELS_PATH!, JSON.stringify({
    "zhipuai-coding-plan": { id: "zhipuai-coding-plan", name: "国内 GLM", env: ["ZHIPU_API_KEY"], api: "https://open.bigmodel.cn/api/coding/paas/v4", npm: "@ai-sdk/openai-compatible", models: { "glm-4.7": model("glm-4.7") } },
    deepseek: { id: "deepseek", name: "DeepSeek", env: ["DEEPSEEK_API_KEY"], api: "https://api.deepseek.com", npm: "@ai-sdk/deepseek", models: { "deepseek-chat": model("deepseek-chat") } },
    openai: { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], api: "https://api.openai.com/v1", npm: "@ai-sdk/openai", models: { "gpt-5.4": model("gpt-5.4") } },
  }), { mode: 0o600 });
  await writeFile(join(root, "config/opencode/opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled", snapshot: false,
    model: "deepseek/deepseek-chat", small_model: "deepseek/deepseek-chat", permission: "deny",
    enabled_providers: ["zhipuai-coding-plan", "openai", "deepseek"],
    provider: { "zhipuai-coding-plan": { options: { apiKey: sentinels[0], baseURL: "https://open.bigmodel.cn/api/coding/paas/v4" } } },
  }), { mode: 0o600 });
  await writeFile(join(root, "config/opencode/tui.json"), JSON.stringify({
    $schema: "https://opencode.ai/tui.json", theme: "opencode",
    plugin: [pathToFileURL(join(repository, "tests/smoke/entry.tsx")).href],
    keybinds: { sidebar_toggle: "f6", session_list: "f7", theme_switch_mode: "f8", app_exit: "f10" },
  }), { mode: 0o600 });
  let api: Awaited<ReturnType<typeof startServer>>;
  await step("config/auth/env 与原生 OAuth provider.list", async () => {
    const envApi = await startServer(binary, { ...env, OPENCODE_AUTH_CONTENT: JSON.stringify(auth), DEEPSEEK_API_KEY: sentinels[1]! });
    providerContract(await envApi("/provider"), "env");
    await stop(server!);
    api = await startServer(binary, env);
    const health = await api("/global/health");
    requireThat(record(health) && health.version === targetVersion, "serve health 版本不匹配");
    providerContract(await api("/provider"), "api");
    await artifact("provider-contract.txt", "PASS：GLM config 有效 apiKey；DeepSeek env/api 有效 key；OpenAI 原生 OAuth-only custom/dummy；三渠道均 connected 且有模型。原始返回未保存。\n");
  });
  const sessions: string[] = [];
  const dbPath = join(root, "data/opencode/opencode.db");
  let baseline = "";
  await step("宿主建会话与合成 DB", async () => {
    for (const title of ["Quota Smoke Alpha", "Quota Smoke Beta"]) {
      const session = await api("/session", { title });
      requireThat(record(session) && typeof session.id === "string" && /^ses_[\w]+$/.test(session.id), "POST /session 未返回有效会话 id");
      sessions.push(session.id);
    }
    await stop(server!);
    const info = await lstat(dbPath);
    requireThat(info.isFile() && !info.isSymbolicLink(), "隔离宿主没有生成标准数据库");
    const db = new Database(dbPath, { readwrite: true, create: false });
    try {
      requireThat((db.query("SELECT count(*) AS n FROM message").get() as { n: number }).n === 0
        && (db.query("SELECT count(*) AS n FROM session_message").get() as { n: number }).n === 0, "准备会话产生了意外消息");
      const now = Date.now();
      const insert = db.query("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)");
      for (const [index, id] of sessions.entries()) {
        insert.run(`msg_quota_smoke_${index}`, id, now, now, JSON.stringify({
          role: "assistant", providerID: "deepseek", modelID: "deepseek-chat", cost: index === 0 ? 0.25 : 0.5,
          time: { created: now, completed: now }, parentID: "msg_quota_smoke_parent", mode: "build", agent: "build",
          path: { cwd: join(root, "project"), root: join(root, "project") },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
        }));
      }
      // 按 v1.18.30 真实 todo schema 插入 Alpha 会话的合成标记；禁止用模型生成 todo 或调用不存在的写 API。
      db.query("INSERT INTO todo(session_id,content,status,priority,position,time_created,time_updated) VALUES (?,?,?,?,?,?,?)")
        .run(sessions[0], "Quota smoke 合成待办", "pending", "high", 0, now, now);
      requireThat((db.query("SELECT count(*) AS n FROM todo").get() as { n: number }).n === 1, "合成 todo 标记未按真实 schema 写入");
      baseline = dbRows(db);
    } finally { db.close(); }
  });
  await step("真实 PTY 自动侧栏", async () => {
    socket = join(root, "tmux.sock");
    tmuxStarted = true;
    // tmux 3.2a 没有 pane_dead_status；由透明的 PTY 子进程包装器记录真实退出码。
    // stdin/stdout/stderr 全继承终端，不产生管道 prompt，环境仍来自上面的 allowlist。
    const runner = join(root, "run-host.ts");
    await writeFile(runner, `import { writeFileSync } from "node:fs";
const child = Bun.spawn([process.argv[2], "--session", process.argv[3]], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
const exitCode = await child.exited;
writeFileSync(${JSON.stringify(join(root, "host-exit.json"))}, JSON.stringify({exitCode, signalCode: child.signalCode ?? null}), {mode: 0o600});
process.exit(exitCode);
`, { mode: 0o600 });
    // 独立 socket 不接触现有 tmux；env -i 再隔离一次，且多参数直接 exec，不经过用户 shell rc。
    await tm("new-session", "-d", "-s", "quota", "-x", "160", "-y", "80", "-c", join(root, "project"),
      "/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), process.execPath, runner, binary, sessions[0]!);
    await tm("set-option", "-w", "-t", "quota:0", "remain-on-exit", "on");
    await visible(["Quota Smoke Alpha", "GLM Coding Plan", "GPT Pro20x", "DeepSeek", "5h", "week", "23%", "45%", "12%", "34%", "reset in", "Balance USD 123.450000", "Context", "Todo", "Quota smoke 合成待办"], "真实侧栏与凭据组合未就绪", 30000);
    await until(async () => hasQuotaTitle(await screen()), "侧栏标题未整行出现 Quota");
    await capture("01-sidebar-160x80");
    const sidebar = await screen();
    const rowOf = (marker: string) => sidebar.split("\n").findIndex((line) => line.includes(marker));
    const contextRow = rowOf("Context");
    const todoRow = rowOf("Todo");
    const quotaRow = sidebar.split("\n").findIndex((line) => /^Quota [▾▸]/.test(line.trim()));
    requireThat(contextRow >= 0 && todoRow >= 0 && quotaRow >= 0, "侧栏缺少原生 Context/Todo 或 Quota 区块");
    // 宿主按 order 升序渲染：原生标记区块在上，Quota(600) 在最后。
    requireThat(contextRow < quotaRow && todoRow < quotaRow, "原生区块未排在 Quota 之前");
    // 展示反馈：水平字符条真实渲染（█/░ 块字符），侧栏无冗余正常状态、更新时间与命令提示。
    requireThat(/[█░]/.test(sidebar), "Quota 水平条未渲染 █/░ 块字符");
    for (const redundant of ["Updated", "Remote updated", "Local updated", "Plan:", "Account available", "Local spend", "Today", "This week", "This month", "/quota-refresh"]) {
      requireThat(!contains(sidebar, redundant), `侧栏出现冗余正常状态、更新时间或命令提示：${redundant}`);
    }
    requireThat((await requests()).length === 3, "启动不是恰好三个 mock GET");
  });
  await step("quota-refresh 三渠道 GET", async () => {
    await sleep(3200);
    await slash("quota-refresh");
    await until(async () => (await requests()).length === 6, "手动刷新没有重新查询全部三渠道");
    await visible(["Quota refreshed"], "手动刷新缺少完成反馈");
    await capture("03-refreshed");
  });
  await step("切换会话与隐藏侧栏", async () => {
    await keys("F7");
    await visible(["Quota Smoke Beta"], "会话列表未就绪");
    await keys("-l", "Quota Smoke Beta");
    await sleep(500);
    await keys("Enter");
    await visible(["Quota Smoke Beta", "Balance USD 123.450000"], "切换会话后侧栏或余额异常");
    await until(async () => {
      const text = await screen();
      return !contains(text, "Quota Smoke Alpha") && !contains(text, "Sessions");
    }, "会话列表未关闭或仍处于 Alpha 会话");
    await capture("04-session-beta");
    await keys("F6");
    await until(async () => !hasQuotaTitle(await screen()), "隐藏侧栏失败");
    await capture("05-sidebar-hidden");
    await keys("F6");
    await visible(["Balance USD 123.450000"], "恢复侧栏失败");
    await until(async () => hasQuotaTitle(await screen()), "恢复侧栏后标题未出现");
  });
  await step("深浅主题与窄屏恢复", async () => {
    const dark = colors(await tm("capture-pane", "-p", "-e", "-t", "quota:0.0"));
    requireThat(dark !== "[]", "PTY 没有捕获真实颜色序列");
    await keys("F8");
    await until(async () => colors(await tm("capture-pane", "-p", "-e", "-t", "quota:0.0")) !== dark, "主题切换未改变真实颜色");
    await visible(["Balance USD 123.450000"], "浅色主题内容丢失");
    await until(async () => hasQuotaTitle(await screen()), "浅色主题侧栏标题丢失");
    await capture("06-theme-switched");
    // 详情页已随消费统计移除：窄屏只验证侧栏隐藏期间宿主不崩溃、恢复宽屏后组件完整。
    await keys("F6");
    await until(async () => !hasQuotaTitle(await screen()), "窄屏准备时隐藏侧栏失败");
    for (const width of [42, 24]) {
      await tm("resize-window", "-t", "quota:0", "-x", String(width), "-y", "24");
      await sleep(500);
      await until(async () => !hasQuotaTitle(await screen()), "窄屏下侧栏应保持隐藏");
      await capture(`07-narrow-${width}`);
    }
    await tm("resize-window", "-t", "quota:0", "-x", "160", "-y", "80");
    await keys("F6");
    await visible(["Balance USD 123.450000"], "恢复宽屏后组件失效");
    await until(async () => hasQuotaTitle(await screen()), "恢复宽屏后侧栏标题未出现");
  });
  await step("正常退出与零新增消息", async () => {
    await keys("F10");
    await until(async () => (await tm("display-message", "-p", "-t", "quota:0.0", "#{pane_dead}" )).trim() === "1", "宿主未正常退出", 10000);
    const exit: unknown = JSON.parse(await readFile(join(root, "host-exit.json"), "utf8"));
    await artifact("exit-status.txt", JSON.stringify(exit));
    requireThat(record(exit) && exit.exitCode === 0 && exit.signalCode === null, "宿主退出码非零或被信号终止");
    const db = new Database(dbPath, { readonly: true, create: false });
    try { requireThat(dbRows(db) === baseline, "消息表发生新增或修改，可能有意外 prompt"); }
    finally { db.close(); }
    await artifact("messages.txt", "PASS：退出后 v1 message 与 session_message 签名均未变化（仅两条预置 assistant 元数据）。\n");
  });
  await step("安全日志/缓存/请求审计", async () => {
    const calls = await requests();
    requireThat(calls.length === 6 && calls.every((call) => call.method === "GET" && ["glm", "openai", "deepseek"].includes(call.kind)), "发现未授权 mock 请求或额外刷新");
    for (const kind of ["glm", "openai", "deepseek"]) requireThat(calls.filter((call) => call.kind === kind).length === 2, "各渠道请求次数不一致");
    await artifact("requests.ndjson", JSON.stringify(calls, null, 2));
    await scanSafeFiles(join(root, "state/opencode/channel-quota"), "quota-cache");
    await scanSafeFiles(join(root, "data/opencode/log"), "host-log");
    await Promise.all(serverDrains);
    await artifact("serve.log", serverOutputs.join(""));
    requireThat(!leaked, "合成 secret/account sentinel 出现在界面、缓存或日志；已脱敏保存");
  });
} catch (error) {
  failed = true;
  reason = error instanceof SmokeFailure ? error.message : "准备或执行发生异常；原始异常未输出以避免凭据泄露";
  checks.set(activeCheck, `FAIL：${reason}`);
  // 仅隔离 smoke 的合成输入诊断，经统一 sentinel 脱敏落盘，不将原始异常输出到终端。
  if (report && error instanceof Error) {
    await artifact("failure-diagnostic.txt", `${activeCheck}\n${error.name}\n${error.message}\n${error.stack ?? ""}\n`);
  }
  if (report && tmuxStarted) {
    try { await capture("failure-screen"); } catch { /* 宿主已退出时保留其余证据，不伪造画面。 */ }
  }
} finally {
  try {
    if (server) await stop(server);
    if (tmuxStarted) {
      const result = await command([tmux, "-S", socket, "-f", "/dev/null", "kill-server"]);
      // 只操作本次随机 socket；无法确认关闭则阻塞，保留临时目录便于检查。
      requireThat(result.code === 0, "本次 tmux 清理失败");
    }
    if (report) {
      await Promise.all(serverDrains);
      await artifact("serve.log", serverOutputs.join(""));
      await scanSafeFiles(join(root, "data/opencode/log"), "host-log");
      await scanSafeFiles(join(root, "state/opencode/channel-quota"), "quota-cache");
    }
    if (root) {
      requireThat(dirname(root) === "/tmp/opencode" && /^channel-quota-smoke-[\w-]+$/.test(root.split("/").at(-1)!), "临时目录前缀不匹配，拒绝删除");
      await safeDirectory(root);
      requireThat((await lstat(root)).uid === process.getuid?.(), "临时目录不属于本进程用户，拒绝删除");
      await rm(root, { recursive: true, force: false });
    }
    checks.set("清理", "PASS");
  } catch {
    failed = true;
    checks.set("清理", "FAIL：未确认清理完成；仅检查本次报告记录的临时目录与 socket，禁止批量终止其他宿主");
  }
  if (leaked) { failed = true; checks.set("安全日志/缓存/请求审计", "FAIL：发现 sentinel 泄露，保存的证据已脱敏"); }
  const summary = [`${failed ? "FAIL" : "PASS"}：目标宿主合成凭据 smoke`, `目标版本=${targetVersion}；观测版本=${redact(observedVersion)}`,
    `临时目录=${root || "未创建"}`, ...[...checks].map(([name, result]) => `${name}：${result === "NOT_RUN" ? `NOT_RUN（前置失败：${reason || "环境准备未完成"}）` : result}`),
    "真实三账号查询：NOT_RUN（未授权；全部供应商响应为 mock，不代表真实认证通过）", "截图为真实 tmux capture-pane 的文本/ANSI，不是重绘图片。", ""].join("\n");
  if (report) await artifact("summary.txt", summary);
  console.log(`${failed ? "FAIL" : "PASS"} smoke；报告：${report || "未创建（检查 /tmp/opencode 与报告目录权限）"}`);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  process.exitCode = failed ? 1 : 0;
}
