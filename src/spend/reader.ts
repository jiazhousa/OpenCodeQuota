import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SafeError, SpendSnapshot } from "../core/contracts.ts";
import { aggregateSpend, createLoadingSpendSnapshot, type CostRow } from "./aggregate.ts";

interface Projection {
  id: string;
  session_id: string;
  time_created: unknown;
  has_session: number;
  json_valid: number;
  role: unknown;
  provider: unknown;
  cost: unknown;
  cost_type: string | null;
}

// CASE 短路保护坏 JSON；不投影 data/part/text，也不将对象型 cost 解码回 JS。
const PROJECTION = `SELECT m.id, m.session_id, m.time_created,
  CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS has_session,
  json_valid(m.data) AS json_valid,
  CASE WHEN json_valid(m.data) THEN CASE WHEN json_type(m.data, '$.role') = 'text'
    AND length(json_extract(m.data, '$.role')) <= 128 THEN json_extract(m.data, '$.role') END END AS role,
  CASE WHEN json_valid(m.data) THEN CASE WHEN json_type(m.data, '$.providerID') = 'text'
    AND length(json_extract(m.data, '$.providerID')) <= 128 THEN json_extract(m.data, '$.providerID') END END AS provider,
  CASE WHEN json_valid(m.data) THEN json_type(m.data, '$.cost') END AS cost_type,
  CASE WHEN json_valid(m.data) THEN CASE WHEN json_type(m.data, '$.cost') IN ('integer', 'real')
    THEN json_extract(m.data, '$.cost') END END AS cost
  FROM message m LEFT JOIN session s ON s.id = m.session_id`;

function normalize(row: Projection): CostRow {
  const base = { id: row.id, sessionId: row.session_id };
  if (!row.json_valid) return { ...base, kind: "unknown" };
  if (["user", "system", "tool"].includes(String(row.role)) ||
    (typeof row.provider === "string" && row.provider.length > 0 && row.provider !== "deepseek")) {
    return { ...base, kind: "excluded" };
  }
  if (row.role !== "assistant" || row.provider !== "deepseek" || !row.has_session) {
    return { ...base, kind: "unknown" };
  }
  if ((row.cost_type !== "integer" && row.cost_type !== "real") || typeof row.cost !== "number" ||
    !Number.isFinite(row.cost) || row.cost < 0 || typeof row.time_created !== "number" ||
    !Number.isSafeInteger(row.time_created) || !Number.isFinite(new Date(row.time_created).getTime())) {
    return { ...base, kind: "invalid" };
  }
  return { ...base, kind: "valid", cost: row.cost, createdAt: row.time_created };
}

class ReadFailure {
  constructor(readonly error: SafeError) {}
}

function safeError(error: unknown): SafeError {
  if (error instanceof ReadFailure) return error.error;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return { code: code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" ? "database_busy" : "database_unavailable" };
}

// 生产环境仅由 worker.ts 创建；所有连接、Map 和遍历均留在 Worker 内。
export class SpendReader {
  private db?: Database;
  private identity?: string;
  private rows = new Map<string, CostRow>();
  private updatedAt?: number;
  private failure?: SafeError;

  constructor(private readonly path: string) {}

  private fileIdentity(): string {
    if (!isAbsolute(this.path) || this.path.includes("\0")) {
      throw new ReadFailure({ code: "database_unavailable" });
    }
    const stat = statSync(this.path, { bigint: true });
    if (!stat.isFile()) throw new ReadFailure({ code: "database_unavailable" });
    return `${stat.dev}:${stat.ino}`;
  }

  private connect(): boolean {
    const identity = this.fileIdentity();
    const changed = this.identity !== identity;
    if (changed) {
      this.close();
      this.rows = new Map();
      this.updatedAt = undefined;
      this.identity = identity;
    }
    if (!this.db) {
      const db = new Database(this.path, { readonly: true, create: false });
      try {
        db.exec("PRAGMA query_only = 1; PRAGMA busy_timeout = 250;");
        if (identity !== this.fileIdentity()) throw new ReadFailure({ code: "database_unavailable" });
        this.db = db;
      } catch (error) {
        db.close();
        throw error;
      }
    }
    return changed;
  }

  private validateSchema(): void {
    const db = this.db!;
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message')").all();
    for (const [table, required] of [["session", ["id"]], ["message", ["id", "session_id", "time_created", "data"]]] as const) {
      if (!tables.some((row) => row.name === table)) throw new ReadFailure({ code: "database_schema_error" });
      const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
      if (!required.every((name) => columns.some((column) => column.name === name))) {
        throw new ReadFailure({ code: "database_schema_error" });
      }
    }
  }

  private attempt(now: number, read: () => void): SpendSnapshot {
    try {
      read();
      this.updatedAt = now;
      this.failure = undefined;
    } catch (error) {
      this.failure = safeError(error);
    }
    return this.snapshot(now);
  }

  full(now: number): SpendSnapshot {
    return this.attempt(now, () => {
      this.connect();
      const next = this.db!.transaction(() => {
        this.validateSchema();
        const rows = new Map<string, CostRow>();
        for (const row of this.db!.query<Projection, []>(PROJECTION).iterate()) rows.set(row.id, normalize(row));
        return rows;
      }).deferred();
      if (this.identity !== this.fileIdentity()) {
        this.close();
        this.rows.clear();
        this.updatedAt = undefined;
        throw new ReadFailure({ code: "database_unavailable" });
      }
      this.rows = next;
    });
  }

  ids(ids: string[], now: number): SpendSnapshot {
    // 增量期间也拒绝沿用已替换文件的旧连接；新文件先完整建立基线。
    try {
      if (this.connect() || this.updatedAt === undefined) return this.full(now);
    } catch (error) {
      this.failure = safeError(error);
      return this.snapshot(now);
    }
    return this.attempt(now, () => {
      const unique = [...new Set(ids)];
      const updates = this.db!.transaction(() => {
        const rows = new Map<string, CostRow>();
        for (let index = 0; index < unique.length; index += 500) {
          const batch = unique.slice(index, index + 500);
          const query = this.db!.query<Projection, string[]>(`${PROJECTION} WHERE m.id IN (${batch.map(() => "?").join(",")})`);
          try {
            for (const row of query.iterate(...batch)) rows.set(row.id, normalize(row));
          } finally { query.finalize(); }
        }
        return rows;
      }).deferred();
      if (this.identity !== this.fileIdentity()) {
        this.close();
        this.rows.clear();
        this.updatedAt = undefined;
        throw new ReadFailure({ code: "database_unavailable" });
      }
      for (const id of unique) {
        const row = updates.get(id);
        if (row) this.rows.set(id, row);
        else this.rows.delete(id);
      }
    });
  }

  snapshot(now: number): SpendSnapshot {
    const snapshot = this.updatedAt === undefined
      ? createLoadingSpendSnapshot(now) : aggregateSpend(this.rows.values(), now, this.updatedAt);
    if (this.failure) {
      snapshot.phase = this.updatedAt === undefined ? "error" : "stale";
      snapshot.error = this.failure;
    }
    return snapshot;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
