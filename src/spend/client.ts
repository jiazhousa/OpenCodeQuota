import type { SafeError, SpendOptions, SpendPort, SpendSnapshot, TimeoutHandle } from "../core/contracts.ts";
import { createLoadingSpendSnapshot } from "./aggregate.ts";
import type { SpendRequest, SpendResponse, SpendResult } from "./protocol.ts";

export interface SpendWorker {
  postMessage(request: SpendRequest): void;
  terminate(): void;
}

export interface SpendWorkerHandlers {
  onMessage(response: SpendResponse): void;
  onError(): void;
}

export interface SpendClientDependencies {
  createWorker(handlers: SpendWorkerHandlers): SpendWorker;
}

function createWorker(handlers: SpendWorkerHandlers): SpendWorker {
  const worker = new Worker(new URL("./worker.ts", import.meta.url).href);
  worker.onmessage = (event: MessageEvent<SpendResponse>) => handlers.onMessage(event.data);
  worker.onerror = (event) => {
    event.preventDefault();
    handlers.onError();
  };
  worker.onmessageerror = () => handlers.onError();
  return { postMessage: (request) => worker.postMessage(request), terminate: () => worker.terminate() };
}

export function createSpendClient(options: SpendOptions, dependencies: SpendClientDependencies = { createWorker }): SpendPort {
  const { clock, signal, onChange } = options;
  let disposed = false;
  let started = false;
  let worker: SpendWorker | undefined;
  let generation = 0;
  let requestId = 0;
  let pending: { id: number; finish(result: SpendResult): void; watchdog: TimeoutHandle } | undefined;
  let snapshot: SpendSnapshot = createLoadingSpendSnapshot(clock.now());
  let periodic: TimeoutHandle | undefined;
  let flushTimer: TimeoutHandle | undefined;
  let running = false;
  let fullWanted = false;
  let sessionDeleted = false;
  let idsReady = false;
  const ids = new Set<string>();
  let tickNow: number | undefined;
  let waiters: Array<() => void> = [];

  function publish(result: SpendResult): void {
    if (disposed) return;
    if (result.ok) snapshot = result.snapshot;
    else snapshot = {
      ...snapshot,
      phase: snapshot.updatedAt === undefined ? "error" : "stale",
      error: result.error,
    };
    onChange(snapshot);
  }

  function finish(result: SpendResult): void {
    if (!pending) return;
    const current = pending;
    pending = undefined;
    clock.clearTimeout(current.watchdog);
    current.finish(result);
  }

  function failWorker(error: SafeError): void {
    generation++;
    worker?.terminate();
    worker = undefined;
    if (pending) finish({ ok: false, error });
    else publish({ ok: false, error });
  }

  function ensureWorker(): boolean {
    if (worker) return true;
    const token = ++generation;
    try {
      worker = dependencies.createWorker({
        onMessage(response) {
          if (disposed || token !== generation || response.requestId !== pending?.id) return;
          finish(response.result);
        },
        onError() {
          if (!disposed && token === generation) failWorker({ code: "worker_unavailable" });
        },
      });
      return true;
    } catch {
      publish({ ok: false, error: { code: "worker_unavailable" } });
      return false;
    }
  }

  function rpc(request: SpendRequest): Promise<SpendResult> {
    return new Promise((resolve) => {
      const watchdog = clock.setTimeout(() => failWorker({ code: "worker_timeout" }), 10_000);
      pending = { id: request.requestId, finish: resolve, watchdog };
      try { worker!.postMessage(request); }
      catch { failWorker({ code: "worker_unavailable" }); }
    });
  }

  function clearFlush(): void {
    if (flushTimer !== undefined) clock.clearTimeout(flushTimer);
    flushTimer = undefined;
  }

  function settleWaiters(): void {
    const current = waiters;
    waiters = [];
    for (const resolve of current) resolve();
  }

  async function drain(): Promise<void> {
    if (disposed || running || !started) return;
    running = true;
    try {
      while (!disposed) {
        let request: SpendRequest;
        let scanning = false;
        if (fullWanted) {
          fullWanted = false;
          scanning = true;
          const initialize = !worker;
          if (!ensureWorker()) break;
          const kind = sessionDeleted ? "sessionDelete" : "full";
          sessionDeleted = false;
          request = initialize
            ? { kind: "init", dbPath: options.dbPath, requestId: ++requestId, now: clock.now() }
            : { kind, requestId: ++requestId, now: clock.now() };
        } else if (worker && idsReady && ids.size) {
          const batch = [...ids];
          ids.clear();
          idsReady = false;
          clearFlush();
          request = { kind: "ids", ids: batch, requestId: ++requestId, now: clock.now() };
        } else if (worker && tickNow !== undefined) {
          request = { kind: "tick", now: tickNow, requestId: ++requestId };
          tickNow = undefined;
        } else break;
        const result = await rpc(request);
        publish(result);
        if (!worker) {
          // 超时/崩溃后只允许下一次显式或周期校准重建，不能因 dirty 自旋重启。
          fullWanted = false;
          break;
        }
        if (scanning && ids.size) {
          idsReady = true;
          clearFlush();
        }
      }
    } finally {
      running = false;
      settleWaiters();
    }
  }

  function schedule(): void {
    if (disposed) return;
    periodic = clock.setTimeout(() => {
      periodic = undefined;
      void reconcile();
      schedule();
    }, 900_000);
  }

  function reconcile(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (!started) {
      started = true;
      onChange(snapshot);
      schedule();
    }
    fullWanted = true;
    const completion = new Promise<void>((resolve) => waiters.push(resolve));
    void drain();
    return completion;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    generation++;
    clearFlush();
    if (periodic !== undefined) clock.clearTimeout(periodic);
    periodic = undefined;
    try { worker?.postMessage({ kind: "dispose", requestId: ++requestId, now: clock.now() }); }
    catch { /* 释放阶段不回传 Worker 原始异常。 */ }
    worker?.terminate();
    worker = undefined;
    finish({ ok: false, error: { code: "aborted" } });
    ids.clear();
    settleWaiters();
  }

  if (signal.aborted) dispose();
  else signal.addEventListener("abort", dispose, { once: true });

  return {
    start: reconcile,
    reconcile,
    change(change) {
      if (disposed) return;
      if (change.kind !== "message") {
        if (change.kind === "session") sessionDeleted = true;
        void reconcile();
        return;
      }
      ids.add(change.id);
      // 首条事件固定 500ms flush；后续事件不重置计时器，因此不会无限拖延。
      if (flushTimer === undefined) {
        flushTimer = clock.setTimeout(() => {
          flushTimer = undefined;
          idsReady = true;
          void drain();
        }, 500);
      }
    },
    tick(now) {
      if (disposed || !started) return;
      tickNow = now;
      void drain();
    },
    dispose,
  };
}
