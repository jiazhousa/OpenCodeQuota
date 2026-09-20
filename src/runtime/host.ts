import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { HostPort, LocalCheckResult, V2ProviderEntry } from "../core/contracts.ts";

// 本地判定依据 TUI 进程启动参数（未显式连接远端）；宿主版本取自 api.app.version。
// 版本 gate 为 2.*.*（用户决策：自动升级不断供，契约变化由 readProviders 形态校验兜底）。
type HostApi = Pick<TuiPluginApi, "client"> & Pick<TuiPluginApi, "app">;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export function hasExplicitRemote(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  const beforeSeparator = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
  return args[0] === "attach" || beforeSeparator.some((arg) => arg === "--attach" || arg.startsWith("--attach=") || arg === "--server" || arg.startsWith("--server="));
}

export function createHostPort(api: HostApi, argv: readonly string[] = process.argv): HostPort {
  let verified = false;
  return {
    async checkLocal(signal): Promise<LocalCheckResult> {
      verified = false;
      if (signal.aborted) return { ok: false, error: { code: "aborted" } };
      try {
        if (hasExplicitRemote(argv)) {
          return { ok: false, error: { code: "local_unsupported" } };
        }
        const app: unknown = api.app;
        const version = object(app) && typeof app.version === "string" ? app.version : undefined;
        if (!version || !/^2\.\d+\.\d+(-[\w.]+)?$/.test(version)) return { ok: false, error: { code: "version_unsupported" } };
        verified = true;
        return { ok: true };
      } catch {
        return { ok: false, error: { code: signal.aborted ? "aborted" : "host_unavailable" } };
      }
    },
    async readProviders(signal) {
      try {
        if (!verified || signal.aborted) throw new Error();
        const client: unknown = api.client;
        const list = object(client) ? (client as { provider?: { list?: (input?: unknown, init?: unknown) => Promise<unknown> } }).provider?.list : undefined;
        if (typeof list !== "function") throw new Error();
        const response = await (client as { provider: { list: (i?: unknown, o?: unknown) => Promise<unknown> } }).provider.list(undefined, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
        if (signal.aborted) throw new Error();
        const data = object(response) && "data" in response ? (response as { data: unknown }).data : undefined;
        if (!Array.isArray(data)) throw new Error();
        // 逐条形态校验：仅保留 id 为字符串的条目，字段异常降级为整体 host_unavailable。
        const providers: V2ProviderEntry[] = [];
        for (const entry of data) {
          if (!object(entry) || typeof entry.id !== "string") throw new Error();
          providers.push({
            id: entry.id,
            integrationID: typeof entry.integrationID === "string" ? entry.integrationID : undefined,
            name: typeof entry.name === "string" ? entry.name : entry.id,
            activation: typeof entry.activation === "string" ? entry.activation : undefined,
            package: typeof entry.package === "string" ? entry.package : undefined,
            settings: object(entry.settings) ? entry.settings : undefined,
          });
        }
        return providers;
      } catch {
        // 不将 SDK 异常（可能含 URL、请求头和凭据）跨过边界。
        throw { code: "host_unavailable" };
      }
    },
  };
}
