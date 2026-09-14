import type { SafeError, SpendSnapshot } from "../core/contracts.ts";

export type SpendRequest = { requestId: number; now: number } & (
  | { kind: "init"; dbPath: string }
  | { kind: "full" }
  | { kind: "ids"; ids: string[] }
  | { kind: "sessionDelete" }
  | { kind: "tick" }
  | { kind: "dispose" }
);

export type SpendResult = { ok: true; snapshot: SpendSnapshot } | { ok: false; error: SafeError };
export interface SpendResponse {
  requestId: number;
  result: SpendResult;
}
