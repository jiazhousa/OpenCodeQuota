import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { HostPort, LocalCheckResult } from "../core/contracts.ts";

type HostApi = Pick<TuiPluginApi, "client" | "event">;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

// 唯一受限的内部 SDK 读取：不复制 config，也不读取认证头或其他配置。
function baseUrl(api: HostApi): unknown {
  const sdk: unknown = api.client;
  if (!object(sdk) || !object(sdk.client) || typeof sdk.client.getConfig !== "function") return undefined;
  const config: unknown = sdk.client.getConfig();
  return object(config) ? config.baseUrl : undefined;
}

export function hasExplicitAttach(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  const beforeSeparator = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
  return args[0] === "attach" || beforeSeparator.some((arg) => arg === "--attach" || arg.startsWith("--attach="));
}

export function createHostPort(api: HostApi, argv: readonly string[] = process.argv): HostPort {
  let verified = false;
  return {
    async checkLocal(signal): Promise<LocalCheckResult> {
      verified = false;
      if (signal.aborted) return { ok: false, error: { code: "aborted" } };
      try {
        if (hasExplicitAttach(argv) || baseUrl(api) !== "http://opencode.internal") {
          return { ok: false, error: { code: "local_unsupported" } };
        }
        const response = await api.client.global.health({ signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
        if (signal.aborted) return { ok: false, error: { code: "aborted" } };
        if (!response.data || response.error) return { ok: false, error: { code: "host_unavailable" } };
        // 放宽为 v1.*.*（用户决策）：自动升级不断供；数据库/凭据/端点各有独立 schema 探测兜底，契约变化时降级为明确错误而非误显示。
        if (!/^1\.\d+\.\d+$/.test(response.data.version)) return { ok: false, error: { code: "version_unsupported" } };
        verified = true;
        return { ok: true };
      } catch {
        return { ok: false, error: { code: signal.aborted ? "aborted" : "host_unavailable" } };
      }
    },
    async readProviders(signal) {
      try {
        if (!verified || signal.aborted || baseUrl(api) !== "http://opencode.internal") throw new Error();
        const response = await api.client.provider.list(undefined, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
        if (signal.aborted || response.error || !response.data) throw new Error();
        return response.data;
      } catch {
        // 不将 SDK 异常（可能含 URL、请求头和凭据）跨过边界。
        throw { code: "host_unavailable" };
      }
    },
    subscribeCost(onChange) {
      const message = (id: unknown) => {
        if (typeof id === "string" && id.length > 0) onChange({ kind: "message", id });
      };
      const disposers = [
        api.event.on("message.updated", (event) => message(event.properties.info.id)),
        api.event.on("message.removed", (event) => message(event.properties.messageID)),
        api.event.on("session.deleted", (event) => {
          const id = event.properties.sessionID;
          if (typeof id === "string" && id.length > 0) onChange({ kind: "session", id });
        }),
        api.event.on("server.connected", () => onChange({ kind: "reset" })),
        api.event.on("server.instance.disposed", () => onChange({ kind: "reset" })),
      ];
      return () => { for (const dispose of disposers) dispose(); };
    },
  };
}
