import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SpendRequest, SpendResponse, SpendResult } from "../../src/spend/protocol.ts";
import type { SpendSnapshot } from "../../src/core/contracts.ts";

export const SENTINEL = "synthetic-secret-must-not-leave-database";
export const NOW = Date.UTC(2026, 8, 13, 12);

export interface FixtureMessage {
  id: string;
  sessionId?: string;
  createdAt?: number | string | null;
  data?: unknown;
  raw?: string;
}

export function createSpendFixture() {
  const directory = mkdtempSync("/tmp/opencode/channel-quota-spend-");
  const path = join(directory, "opencode.db");
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, data TEXT);
    INSERT INTO session VALUES ('main', 'project-a', NULL, NULL);
    INSERT INTO session VALUES ('child', 'project-b', 'main', NULL);
    INSERT INTO session VALUES ('archived', 'project-c', NULL, 1);`);
  const insert = db.prepare("INSERT OR REPLACE INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)");
  function message(row: FixtureMessage): void {
    insert.run(row.id, row.sessionId ?? "main", row.createdAt === undefined ? NOW : row.createdAt,
      row.raw ?? JSON.stringify(row.data ?? { role: "assistant", providerID: "deepseek", cost: 1, text: SENTINEL }));
  }
  let closed = false;
  return {
    directory, path, db, message,
    messages(rows: FixtureMessage[]) { db.transaction(() => rows.forEach(message))(); },
    close() {
      if (closed) return;
      closed = true;
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

type RequestBody = SpendRequest extends infer Request
  ? Request extends SpendRequest ? Omit<Request, "requestId"> : never : never;

// 测试读取也走真实生产 Worker；主线程 SQLite 仅用于构造临时合成夹具。
export function createReaderWorker() {
  const worker = new Worker(new URL("../../src/spend/worker.ts", import.meta.url).href);
  let id = 0;
  const pending = new Map<number, { resolve(value: SpendResult): void; reject(error: Error): void }>();
  worker.onmessage = (event: MessageEvent<SpendResponse>) => {
    pending.get(event.data.requestId)?.resolve(event.data.result);
    pending.delete(event.data.requestId);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    for (const promise of pending.values()) promise.reject(new Error("合成测试 Worker 失败"));
    pending.clear();
  };
  return {
    async read(request: RequestBody): Promise<SpendSnapshot> {
      const result = await new Promise<SpendResult>((resolve, reject) => {
        const requestId = ++id;
        pending.set(requestId, { resolve, reject });
        worker.postMessage({ ...request, requestId });
      });
      if (!result.ok) throw new Error(result.error.code);
      return result.snapshot;
    },
    close() { worker.terminate(); },
  };
}
