import { SpendReader } from "./reader.ts";
import type { SpendRequest, SpendResponse, SpendResult } from "./protocol.ts";

let reader: SpendReader | undefined;

// 同步 SQLite 回调由 Worker 事件循环顺序执行，不产生重叠扫描。
self.onmessage = (event: MessageEvent<SpendRequest>) => {
  const request = event.data;
  let result: SpendResult;
  try {
    if (request.kind === "dispose") {
      reader?.close();
      reader = undefined;
      result = { ok: false, error: { code: "aborted" } };
    } else {
      if (request.kind === "init") {
        reader?.close();
        reader = new SpendReader(request.dbPath);
      }
      if (!reader) result = { ok: false, error: { code: "worker_unavailable" } };
      else {
        const snapshot = request.kind === "ids" ? reader.ids(request.ids, request.now)
          : request.kind === "tick" ? reader.snapshot(request.now) : reader.full(request.now);
        result = { ok: true, snapshot };
      }
    }
  } catch {
    result = { ok: false, error: { code: "worker_unavailable" } };
  }
  self.postMessage({ requestId: request.requestId, result } satisfies SpendResponse);
  if (request.kind === "dispose") self.close();
};
