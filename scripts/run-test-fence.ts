import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const reports = join(repository, "test-fence-reports");
const args = process.argv.slice(2);
const steps = [
  { name: "build", args: ["run", "build"], timeout: 180000 },
  { name: "unit-ui", args: ["test"], timeout: 300000 },
  { name: "smoke", args: [], timeout: 300000 },
];
const results = steps.map((step) => ({ name: step.name, status: "NOT_RUN", exitCode: "未产生", reason: "等待前置步骤", durationMs: 0 }));
const logs = new Set<string>();
let directory = "";
let temp = "";
let failed = false;
let interrupted = false;
let running: ReturnType<typeof Bun.spawn> | undefined;
const interrupt = () => { interrupted = true; running?.kill("SIGTERM"); };
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

async function summary(status: "RUNNING" | "PASS" | "FAIL") {
  const text = [`${status}：OpenCode Channel Quota fence`, `目标宿主版本：动态探测（实测值及挂载证据见 smoke 报告；运行时门为 1.x.y）`,
    `本轮目录：${directory}`, `时间：${new Date().toISOString()}`,
    ...results.map((item) => `${item.name}：${item.status}；exit=${item.exitCode}；${item.durationMs}ms；${item.reason}`),
    "真实供应商账号查询：NOT_RUN（未授权，不属于自动 fence；mock PASS 不是账号认证通过）", ""].join("\n");
  await writeFile(join(directory, "summary.txt"), text, { mode: 0o600 });
  const next = join(reports, `.summary-${process.pid}-${crypto.randomUUID()}.tmp`);
  await writeFile(next, text, { mode: 0o600 });
  await rename(next, join(reports, "summary.txt"));
}

try {
  await mkdir(reports, { recursive: true, mode: 0o700 });
  if ((await lstat(reports)).isSymbolicLink() || await realpath(reports) !== reports.replace(/\/$/, "")) throw new Error();
  directory = await mkdtemp(join(reports, "fence-"));
  await summary("RUNNING");
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--opencode")) {
    throw new Error();
  }
  if (!(await lstat("/tmp/opencode")).isDirectory() || await realpath("/tmp/opencode") !== "/tmp/opencode") throw new Error();
  temp = await mkdtemp("/tmp/opencode/channel-quota-fence-");
  const path = process.env.PATH ?? "/usr/bin:/bin";
  const npm = Bun.which("npm", { PATH: path });
  if (!npm) throw new Error();
  // 测试也不继承供应商/SSH/OpenCode 配置变量，npm 不读取用户配置。
  const env: Record<string, string> = { PATH: path, HOME: temp, TMPDIR: temp, LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    NPM_CONFIG_USERCONFIG: join(temp, "user.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(temp, "global.npmrc"), NPM_CONFIG_CACHE: join(temp, "npm-cache") };
  for (const [index, step] of steps.entries()) {
    const result = results[index]!;
    if (failed || interrupted) {
      result.reason = interrupted ? "收到中止信号" : "前置步骤失败，未执行";
      await writeFile(join(directory, `${step.name}.log`), `NOT_RUN：${result.reason}\n`, { mode: 0o600 });
      logs.add(step.name);
      continue;
    }
    const command = step.name === "smoke"
      ? [process.execPath, join(repository, "scripts/smoke.ts"), ...args]
      : [npm, ...step.args];
    result.status = "RUNNING";
    await summary("RUNNING");
    const start = Date.now();
    const child = Bun.spawn(command, { cwd: repository, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    running = child;
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    let timedOut = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // 留给 smoke 清理自己的 PID/socket 的时间；最终仍非零，不将 watchdog 视为通过。
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 15000);
    }, step.timeout);
    try {
      const code = await child.exited;
      result.exitCode = String(code);
      result.durationMs = Date.now() - start;
      result.status = code === 0 && !timedOut && !interrupted ? "PASS" : "FAIL";
      result.reason = timedOut ? "超时；检查 smoke 清理记录" : interrupted ? "收到中止信号" : result.status === "PASS" ? "已执行" : "子进程非零退出";
      failed ||= result.status === "FAIL";
      await writeFile(join(directory, `${step.name}.log`),
        `command=${step.name === "smoke" ? "bun scripts/smoke.ts" : `npm ${step.args.join(" ")}`}\nexit=${code}\n${await stdout}\n--- stderr ---\n${await stderr}\n`, { mode: 0o600 });
      logs.add(step.name);
      console.log(`${step.name}：${result.status}，exit=${code}，${result.durationMs}ms`);
    } finally {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      running = undefined;
    }
    await summary("RUNNING");
  }
} catch {
  failed = true;
  const active = results.find((result) => result.status === "RUNNING") ?? results.find((result) => result.status === "NOT_RUN");
  if (active) { active.status = "FAIL"; active.reason = "环境/参数/进程或报告写入失败；用法 npm run fence -- --opencode /绝对路径/opencode"; }
  for (const item of results) if (item.status === "NOT_RUN") item.reason = "环境或前置步骤失败，未执行";
} finally {
  failed ||= interrupted;
  if (running && running.exitCode === null) {
    running.kill("SIGTERM");
    await Promise.race([running.exited, new Promise((done) => setTimeout(done, 15000))]);
    if (running.exitCode === null) running.kill("SIGKILL");
    await running.exited;
  }
  if (temp) {
    try {
      const info = await lstat(temp);
      if (!/^\/tmp\/opencode\/channel-quota-fence-[\w-]+$/.test(temp) || info.isSymbolicLink()
        || info.uid !== process.getuid?.() || await realpath(temp) !== temp) throw new Error();
      await rm(temp, { recursive: true, force: false });
    } catch { failed = true; results.push({ name: "cleanup", status: "FAIL", exitCode: "未产生", reason: "fence 临时目录清理失败", durationMs: 0 }); }
  }
  if (directory) {
    for (const item of results) {
      if (!logs.has(item.name)) await writeFile(join(directory, `${item.name}.log`), `${item.status}；exit=${item.exitCode}；${item.reason}\n`, { mode: 0o600 });
    }
    await summary(failed ? "FAIL" : "PASS");
  }
  console.log(`${failed ? "FAIL" : "PASS"} fence；汇总：${directory ? join(reports, "summary.txt") : "无法创建报告目录"}`);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  process.exitCode = failed ? 1 : 0;
}
