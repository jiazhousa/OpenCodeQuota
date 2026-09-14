import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Env, SafeError } from "../core/contracts.ts";

export type PathResult = { ok: true; path: string } | { ok: false; error: SafeError };

function unavailable(): PathResult {
  return { ok: false, error: { code: "path_unavailable" } };
}

function directory(env: Env, key: string, fallback: string, home: string): PathResult {
  const value = env[key];
  if (value !== undefined) {
    if (!value || !isAbsolute(value) || value.includes("\0")) return unavailable();
    return { ok: true, path: join(value, "opencode") };
  }
  if (!isAbsolute(home) || home.includes("\0")) return unavailable();
  return { ok: true, path: join(home, fallback, "opencode") };
}

export function resolveDataDirectory(env: Env, home = homedir()): PathResult {
  return directory(env, "XDG_DATA_HOME", ".local/share", home);
}

export function resolveStateDirectory(env: Env, home = homedir()): PathResult {
  const result = directory(env, "XDG_STATE_HOME", ".local/state", home);
  return result.ok ? { ok: true, path: join(result.path, "channel-quota") } : result;
}

export async function resolveDatabasePath(env: Env, home = homedir()): Promise<PathResult> {
  const data = resolveDataDirectory(env, home);
  if (!data.ok) return data;
  const explicit = env.OPENCODE_DB;
  if (explicit !== undefined) {
    // SQLite URI、内存库及空值都不能被解释成可创建的默认文件。
    if (!explicit || explicit.includes("\0") || explicit === ":memory:" || /^[a-z][a-z0-9+.-]*:/i.test(explicit)) {
      return unavailable();
    }
    return { ok: true, path: resolve(data.path, explicit) };
  }
  try {
    // 这里只读文件名，绝不逐库打开或根据消息猜测活跃库。
    const entries = await readdir(data.path);
    if (entries.some((name) => /^opencode.*\.db$/.test(name) && name !== "opencode.db")) {
      return { ok: false, error: { code: "database_ambiguous" } };
    }
    return { ok: true, path: join(data.path, "opencode.db") };
  } catch {
    return { ok: false, error: { code: "database_unavailable" } };
  }
}
