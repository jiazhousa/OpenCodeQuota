import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { PROVIDER_IDS } from "../core/contracts.ts";
import type { Clock, Env, QuotaCache, QuotaCacheKey, QuotaSnapshot, Window } from "../core/contracts.ts";
import { record } from "./credentials.ts";
import { validAmount, validCurrency } from "./deepseek.ts";

const MAX_SIZE = 64 * 1024;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const labels = { "5h": "5 小时", week: "周额度", mcp: "MCP 额度", unknown: "未知窗口" } as const;
const validTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));

// 严格投影持久格式，不把篡改或旧版本文件的额外字段送进视图。
export function validateSnapshot(value: unknown, key: QuotaCacheKey, now: number): QuotaSnapshot | null {
  if (!record(value) || !exact(value, ["providerId", "windows", "balances", "plan", "available", "fetchedAt"]) ||
      value.providerId !== key.providerId || !validTime(value.fetchedAt) || value.fetchedAt > now || now - value.fetchedAt > MAX_AGE ||
      !Array.isArray(value.windows) || value.windows.length > 100 || !Array.isArray(value.balances) || value.balances.length > 100 ||
      !(value.available === null || typeof value.available === "boolean") ||
      !(value.plan === null || ["Free", "Plus", "Pro", "Team", "Business", "Enterprise", "Edu"].includes(value.plan as string))) return null;
  const windows: Window[] = [];
  for (const window of value.windows) {
    if (!record(window) || !exact(window, ["id", "label", "kind", "usedPercent", "resetAt"]) ||
        typeof window.id !== "string" || !/^(glm-\d{1,3}|primary_window|secondary_window)$/.test(window.id) ||
        typeof window.kind !== "string" || !Object.hasOwn(labels, window.kind) ||
        window.label !== labels[window.kind as keyof typeof labels] ||
        !(window.usedPercent === null || (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) && window.usedPercent >= 0)) ||
        !(window.resetAt === null || validTime(window.resetAt))) return null;
    windows.push({ id: window.id, label: window.label as string, kind: window.kind as Window["kind"], usedPercent: window.usedPercent as number | null, resetAt: window.resetAt as number | null });
  }
  const balances = [];
  for (const balance of value.balances) {
    if (!record(balance) || !exact(balance, ["currency", "amount"]) || !validCurrency(balance.currency) || !validAmount(balance.amount)) return null;
    balances.push({ currency: balance.currency, amount: balance.amount });
  }
  if (key.providerId === "deepseek" ? windows.length !== 0 || value.plan !== null || typeof value.available !== "boolean"
    : balances.length !== 0 || value.available !== null || (key.providerId !== "openai" && value.plan !== null)) return null;
  return { providerId: key.providerId, windows, balances, plan: value.plan as string | null, available: value.available as boolean | null, fetchedAt: value.fetchedAt };
}

export interface QuotaCacheOptions { env: Env; clock: Clock; home?: string }
export function createQuotaCache({ env, clock, home = homedir() }: QuotaCacheOptions): QuotaCache {
  const state = env.XDG_STATE_HOME;
  const directory = state === undefined ? join(home, ".local/state/opencode/channel-quota")
    : state && isAbsolute(state) ? join(state, "opencode/channel-quota") : null;
  const validKey = (key: QuotaCacheKey) => PROVIDER_IDS.includes(key.providerId) && /^[a-f0-9]{64}$/.test(key.identityHash);
  const filename = (key: QuotaCacheKey) => join(directory!, `${key.providerId}-${key.identityHash}.json`);
  const safeDirectory = async (create: boolean) => {
    if (!directory || !isAbsolute(directory)) return false;
    // 先核查已有祖先，避免 mkdir 经符号链接写到另一个位置。
    const parts: string[] = [];
    for (let part = resolve(directory); part !== parse(part).root; part = dirname(part)) parts.unshift(part);
    for (const part of parts) {
      try {
        const stat = await lstat(part);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      } catch (error) {
        if (!record(error) || error.code !== "ENOENT" || !create) return false;
        await mkdir(part, { mode: 0o700 });
      }
    }
    const stat = await lstat(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid?.();
  };
  const safeTarget = async (path: string) => {
    try {
      const stat = await lstat(path);
      return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid?.();
    } catch (error) { return record(error) && error.code === "ENOENT"; }
  };
  return {
    async load(key, signal) {
      let file;
      try {
        if (signal.aborted || !validKey(key) || !await safeDirectory(false)) return null;
        file = await open(filename(key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_SIZE || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) return null;
        const buffer = Buffer.alloc(MAX_SIZE + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await file.read(buffer, size, buffer.length - size);
          if (!bytesRead) break;
          size += bytesRead;
          if (signal.aborted) return null;
        }
        if (size > MAX_SIZE || signal.aborted) return null;
        const raw: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"));
        if (!record(raw) || !exact(raw, ["schemaVersion", "providerId", "identityHash", "snapshot"]) || raw.schemaVersion !== 1 ||
            raw.providerId !== key.providerId || raw.identityHash !== key.identityHash) return null;
        return validateSnapshot(raw.snapshot, key, clock.now());
      } catch { return null; }
      finally { await file?.close().catch(() => {}); }
    },
    async save(key, snapshot, signal) {
      let temporary: string | undefined;
      let file;
      try {
        if (signal.aborted || !validKey(key)) return;
        const safe = validateSnapshot(snapshot, key, clock.now());
        if (!safe) return;
        const text = JSON.stringify({ schemaVersion: 1, providerId: key.providerId, identityHash: key.identityHash, snapshot: safe });
        if (Buffer.byteLength(text) > MAX_SIZE || !await safeDirectory(true) || signal.aborted) return;
        const target = filename(key);
        if (!await safeTarget(target)) return;
        temporary = join(directory!, `.${randomUUID()}.tmp`);
        file = await open(temporary, "wx", 0o600);
        await file.writeFile(text, "utf8");
        await file.sync();
        await file.close();
        file = undefined;
        if (signal.aborted || !await safeDirectory(false) || !await safeTarget(target)) return;
        await rename(temporary, target);
        temporary = undefined;
      } catch {
        // 缓存为尽力而为；磁盘故障不改变远端查询结果，也不外传路径异常。
      } finally {
        await file?.close().catch(() => {});
        if (temporary) await unlink(temporary).catch(() => {});
      }
    },
  };
}
