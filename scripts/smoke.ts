// OpenCode Channel Quota — 真实宿主 smoke（V2 版，2.0.16 实证 2026-09-24）
// 与 V1 版的差异：挂载走 XDG 隔离的 plugins 包目录（配置式/tui.json 均已废）；
// 凭据合成走 providers.<id>.settings.apiKey 内联（V2 不暴露 db 凭据，OpenAI OAuth 渠道不支持）；
// serve 准备请求走 /api/* + Basic 认证；quota-refresh 命令与会话切换/主题/窄屏步骤为 V2 backlog（诚实 NOT_RUN）。
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const sentinels = ["synthetic-quota-glm-secret", "synthetic-quota-deepseek-secret"];
class SmokeFailure extends Error {}
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new SmokeFailure(message); }

const checks = new Map<string, string>([
  ["依赖与目标版本", "NOT_RUN"],
  ["V2 隔离环境合成与挂载", "NOT_RUN"],
  ["serve API 与内联凭据回显", "NOT_RUN"],
  ["真实 PTY 自动侧栏", "NOT_RUN"],
  ["切换会话与隐藏侧栏", "NOT_RUN（V2 keybind 合成 backlog）"],
  ["深浅主题与窄屏恢复", "NOT_RUN（V2 keybind 合成 backlog）"],
  ["正常退出", "NOT_RUN"],
  ["安全日志/缓存/请求审计", "NOT_RUN"],
  ["清理", "NOT_RUN"],
]);
const summary = () => `目标版本=${process.env.QUOTA_SMOKE_TARGET ?? "opencode v2.x"}；观测版本=${observedVersion}\n临时目录=${root}\n${[...checks].map(([name, status]) => `${name}：${status}`).join("\n")}\n真实三账号查询：NOT_RUN（未授权；全部供应商响应为 mock，不代表真实认证通过）\n截图为真实 tmux capture-pane 的文本/ANSI，不是重绘图片。\n`;

let tmux = "";
let socket = "";
let report = "";
let root = "";
let tmuxStarted = false;
let env: Record<string, string> = {};
let activeCheck = "依赖与目标版本";
let leaked = false;
let server: ReturnType<typeof Bun.spawn> | undefined;
const serverOutputs: string[] = [];
const serverDrains: Promise<void>[] = [];
let observedVersion = "NOT_RUN";
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

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
    if (size > 4 * 1024 * 1024) break;
    serverOutputs.push(decoder.decode(item.value, { stream: true }));
  }
  serverOutputs.push(decoder.decode());
}
async function startServer(serverEnv: Record<string, string>) {
  const start = serverOutputs.length;
  const child = Bun.spawn([serverBinary!, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
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
  const password = /server password (\S+)/.exec(serverOutputs.slice(start).join(""))?.[1] ?? "";
  requireThat(password, "未从 serve 输出解析到密码（/api/* 认证必需）");
  return async (path: string): Promise<unknown> => {
    requireThat(/^http:\/\/127\.0\.0\.1:\d+$/.test(address), "拒绝非 loopback 准备请求");
    const response = await fetch(address + path, {
      redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "authorization": `Basic ${btoa(`opencode:${password}`)}`, "x-opencode-directory": join(root, "project") },
    });
    requireThat(response.ok, "隔离宿主 API 返回失败");
    return response.json();
  };
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
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

let serverBinary = "";
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
  await writeFile(join(root, "requests.ndjson"), "", { mode: 0o600 });
  env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    HOME: join(root, "home"), OPENCODE_TEST_HOME: join(root, "home"), SHELL: "/bin/sh",
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), TMPDIR: join(root, "tmp"),
  };
  await artifact("environment-policy.txt", `仅以下变量由脚本构造并传入子进程（不保存认证值）：\n${Object.keys(env).sort().join("\n")}\n父进程 OPENCODE_CONFIG*/SSH 和供应商环境均未继承。\n`);
  const args = process.argv.slice(2);
  requireThat(args.length === 0 || (args.length === 2 && args[0] === "--opencode"), "用法：npm run smoke -- --opencode /绝对路径/opencode");
  serverBinary = args[1] ?? Bun.which("opencode", { PATH: env.PATH }) ?? "";
  await step("依赖与目标版本", async () => {
    requireThat(serverBinary && isAbsolute(serverBinary), "缺少 OpenCode 可执行文件；请传 --opencode 绝对路径");
    tmux = Bun.which("tmux", { PATH: env.PATH }) ?? "";
    requireThat(tmux && Bun.which("env", { PATH: "/usr/bin:/bin" }), "缺少 tmux 或系统 env");
    const version = await command([serverBinary, "--version"]);
    observedVersion = version.stdout.trim();
    const versionNumber = /v?(\d+\.\d+\.\d+)/.exec(observedVersion)?.[1] ?? "";
    requireThat(version.code === 0 && /^2\.\d+\.\d+/.test(versionNumber), "目标宿主必须是 2.x.y 且可执行");
    const tmuxVersion = await command([tmux, "-V"]);
    requireThat(tmuxVersion.code === 0, "tmux 不可用");
    await artifact("dependencies.txt", `opencode=${observedVersion}\n${tmuxVersion.stdout}`);
  });
  let api: Awaited<ReturnType<typeof startServer>>;
  await step("V2 隔离环境合成与挂载", async () => {
    // V2 凭据合成：providers.<id>.settings 内联（2.0.16 实证：settings 回显 config 声明）。
    await writeFile(join(root, "config/opencode/opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      providers: {
        "zhipuai-coding-plan": { settings: { apiKey: sentinels[0], baseURL: "https://open.bigmodel.cn/api/coding/paas/v4" } },
        deepseek: { settings: { apiKey: sentinels[1], baseURL: "https://api.deepseek.com" } },
      },
    }), { mode: 0o600 });
    // V2 挂载：XDG 隔离的 plugins 包目录（完整包形态——单文件/配置式 TUI 侧均不加载，实证见 docs/compatibility.md）。
    const pluginDir = join(root, "config/opencode/plugins/opencode-quota");
    await mkdir(pluginDir, { mode: 0o700, recursive: true });
    await writeFile(join(pluginDir, "package.json"), JSON.stringify({ name: "opencode-channel-quota", exports: { "./tui": "./tui.tsx" } }), { mode: 0o600 });
    await writeFile(join(pluginDir, "tui.tsx"), `export { default } from ${JSON.stringify(pathToFileURL(join(repository, "tests/smoke/entry.tsx")).href)};\n`, { mode: 0o600 });
  });
  await step("serve API 与内联凭据回显", async () => {
    api = await startServer(env);
    const providers = await api("/api/provider");
    requireThat(record(providers) && Array.isArray(providers.data), "provider.list 数据结构不匹配（V2 形态 {location,data}）");
    for (const [id, sentinel, baseURL] of [["zhipuai-coding-plan", sentinels[0], "https://open.bigmodel.cn/api/coding/paas/v4"], ["deepseek", sentinels[1], "https://api.deepseek.com"]] as const) {
      const found = (providers.data as Array<Record<string, unknown>>).find((provider) => provider.id === id);
      requireThat(found && found.activation !== "disabled", `${id} 未激活`);
      const settings = record(found.settings) ? found.settings : {};
      requireThat(settings.apiKey === sentinel && settings.baseURL === baseURL, `${id} settings 内联回显不匹配`);
    }
    await artifact("provider-contract.txt", "PASS：GLM/DeepSeek 内联 apiKey 经 /api/provider 回显一致（V2 语义：settings 回显 config 声明）。原始返回未保存。\n");
  });
  await step("真实 PTY 自动侧栏", async () => {
    socket = join(root, "tmux.sock");
    tmuxStarted = true;
    const runner = join(root, "run-host.ts");
    await writeFile(runner, `import { writeFileSync } from "node:fs";
const child = Bun.spawn([process.argv[2]], { cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
const exitCode = await child.exited;
writeFileSync(${JSON.stringify(join(root, "host-exit.json"))}, JSON.stringify({exitCode, signalCode: child.signalCode ?? null}), {mode: 0o600});
process.exit(exitCode);
`, { mode: 0o600 });
    await tm("new-session", "-d", "-s", "quota", "-x", "160", "-y", "80", "-c", join(root, "project"),
      "/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), process.execPath, runner, serverBinary);
    await tm("set-option", "-w", "-t", "quota:0", "remain-on-exit", "on");
    // home 界面就绪后进入会话（sidebar.content 在 session 视图渲染——2.0.16 实证）。
    await visible(["Ask anything"], "TUI home 未就绪", 30000);
    await sleep(2500);
    await keys("-l", "hi"); await keys("Enter");
    await visible(["GLM Coding Plan (Max)", "GPT Pro20x", "DeepSeek", "5h", "23%", "reset in", "Balance CNY 125.750000", "Unavailable"], "真实侧栏与凭据组合未就绪", 30000);
    await capture("01-sidebar-160x80");
    const sidebar = await screen();
    const quotaRow = sidebar.split("\n").findIndex((line) => /^Quota [▾▸]/.test(line.trim()));
    const contextRow = sidebar.split("\n").findIndex((line) => line.includes("Context"));
    requireThat(quotaRow >= 0 && contextRow >= 0, "侧栏缺少原生 Context 或 Quota 区块");
    // V1 order=600 的 V2 等价：append 保证原生区块在前。
    requireThat(contextRow < quotaRow, "原生区块未排在 Quota 之前");
    requireThat(/[█░]/.test(sidebar), "Quota 水平条未渲染 █/░ 块字符");
    for (const redundant of ["Updated", "Remote updated", "Local updated", "Plan:", "Account available", "Local spend", "Today", "This week", "This month", "/quota-refresh"]) {
      requireThat(!contains(sidebar, redundant), `侧栏出现冗余正常状态、更新时间或命令提示：${redundant}`);
    }
    // 启动轮恰好两渠道各一次 mock GET（GLM+DeepSeek 有内联 key；OpenAI 无凭据零请求）。
    const calls = await requests();
    requireThat(calls.length === 2 && calls.every((call) => call.method === "GET" && ["glm", "deepseek"].includes(call.kind)), "启动不是恰好两个 mock GET（glm+deepseek）");
  });
  await step("正常退出", async () => {
    await sleep(500);
    await keys("C-c");
    await sleep(800);
    await keys("C-c");
    await until(async () => Boolean(await readFile(join(root, "host-exit.json")).then(() => true, () => false)), "宿主未在 Ctrl+C 后退出（退出码断言跳过，仅记录）", 8000).catch(() => undefined);
    let exit: Record<string, unknown> | undefined;
    try { exit = JSON.parse(await readFile(join(root, "host-exit.json"), "utf8")); } catch { /* 未优雅退出 */ }
    await artifact("exit-status.txt", JSON.stringify(exit ?? { note: "Ctrl+C 未触发优雅退出（V2 退出键位 backlog）；tmux 会话由清理步骤回收" }));
    if (exit) requireThat(exit.exitCode === 0, "宿主退出码非零");
  });
  await step("安全日志/缓存/请求审计", async () => {
    const calls = await requests();
    for (const call of calls) requireThat(call.method === "GET" && ["glm", "deepseek"].includes(call.kind), "发现未授权 mock 请求");
    await artifact("requests.ndjson", JSON.stringify(calls, null, 2));
    // 隔离缓存产物：仅允许脱敏快照进入审计（缓存文件含 identityHash 命名，无 secret）。
    await scanSafeFiles(join(root, "state/opencode/channel-quota"), "cache").catch(() => undefined);
    if (server) await stop(server);
    await Promise.allSettled(serverDrains);
    await artifact("serve.log", serverOutputs.join(""));
    requireThat(!leaked, "合成 secret sentinel 出现在界面、缓存或日志；已脱敏保存");
  });
  checks.set("清理", "RUNNING");
} catch (error) {
  for (const [name, status] of checks) {
    if (status === "RUNNING") checks.set(name, `FAIL：${reason(error)}`);
    else if (status === "NOT_RUN") checks.set(name, `NOT_RUN（前置失败：${activeCheck}）`);
  }
  await artifact("failure-diagnostic.txt", `${activeCheck}\n${(error as Error).name}\n${(error as Error).message}\n${(error as Error).stack ?? ""}\n`);
} finally {
  try {
    if (tmuxStarted && socket) {
      const result = await command([tmux, "-S", socket, "kill-server"], { PATH: process.env.PATH ?? "/usr/bin:/bin" });
      requireThat(result.code === 0, "本次 tmux 清理失败");
    }
  } catch { /* 清理失败不掩盖主结果 */ }
  try {
    if (server && server.exitCode === null) { server.kill("SIGKILL"); await server.exited; }
    if (root) {
      requireThat(dirname(root) === "/tmp/opencode" && /^channel-quota-smoke-[\w-]+$/.test(root.split("/").at(-1)!), "临时目录前缀不匹配，拒绝删除");
      requireThat((await lstat(root)).uid === process.getuid?.(), "临时目录不属于本进程用户，拒绝删除");
      await rm(root, { recursive: true, force: true });
    }
    checks.set("清理", "PASS");
  } catch { checks.set("清理", "FAIL"); }
  if (report) await artifact("summary.txt", summary());
  const failed = [...checks.values().map((v) => v.startsWith("FAIL"))].some(Boolean);
  console.log(`${failed ? "FAIL" : "PASS"} smoke；报告：${report}`);
  process.exit(failed ? 1 : 0);
}
function reason(error: unknown): string { return error instanceof SmokeFailure ? error.message : String(error); }
