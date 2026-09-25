# Compatibility & Data Semantics

## Locked environment

Targets Linux, OpenCode **1.x (tested on 1.18.30 / 1.18.31)**, default local TUI only. Implemented against the [v1.18.30 source (version gate relaxed to 1.*.*, verified on 1.18.31)](https://github.com/anomalyco/opencode/tree/v1.18.30). No promises for other versions, distribution channels, attach mode or explicit network transports. Runtime verification status must be read from the acceptance artifacts; it cannot be inferred from this document.

| Dependency | Exact dev version |
|---|---|
| `@opencode-ai/plugin` / `@opencode-ai/sdk` | 1.18.30 |
| `@opentui/core` / `solid` / `keymap` | 0.4.5 |
| `solid-js` | 1.9.12 |
| TypeScript | 5.8.2 |
| `@types/bun` / in-project Bun | 1.3.13 / 1.3.14 |

Node 24.19.0 / npm 11.17.0 were the prep environment. Distribution is `src/tui.tsx` via file URL, compiled by the host; the source TSX cannot be installed directly as an npm package. `build` emits no dist. Third-party declarations conflict on EventEmitter/TextEncoder; `skipLibCheck: true` does not weaken strict checks over src/tests/scripts, nor prove Solid identity or native dependency compatibility.

## OpenCode 2.x status (dual-sided port shipped 2026-09-25, commit bb938a5 + smoke closure)

OpenCode 2.0.16 verified feasible on 2026-09-24, port shipped on 2026-09-25 (full evidence: OpenCodePipe repo `.specpipe/plans/ocp-plugin-dual-compat/experiment-record.md`, 2026-09-25 sections):

**Architecture.** Official dual-entry mount: a package directory `plugins/<name>/` with `package.json` exporting `"./tui"`. The server process loads the package-root `index.ts` (`src/server.ts`: credential collection via `integration.connection.active/resolve` + controller data layer + RPC `view`/`updated` broadcast); the CLI process loads `./tui` (`src/tui.tsx`: RPC consumption via `client.rpc.call({rpcID, method, input})`, event envelope `{type:"rpc.<id>.<event>", data, location}` via `client.event.subscribe`, plus a 60s polling fallback). Same plugin id in two directories is rejected (Duplicate plugin ID); CLI-side and server-side `ctx.storage` are not shared; CLI-side plugins hot-reload on file change (verified 2026-09-25).

**Credentials (supersedes the earlier "not exposed" misjudgment).** The V2 server-plugin context exposes host credentials: api keys resolve as `{type:"key", key}` (literal `"key"`, not `"api"`), OAuth as `{type:"oauth", access, refresh, expires, metadata:{accountID}}`. All three channels readable, including GPT OAuth. Config inline keys are a second source: they are echoed by `/api/provider` in `settings` and are not overridden by `connection.active`.

**Provider catalog & activation (2026-09-25 findings).** The catalog is fetched asynchronously from `https://models.opencode.ai` (the V1 `models.dev` URL and the `OPENCODE_MODELS_PATH` injection are both dead in V2), cached in the host kv store under `models-dev:catalog`; a cold isolated environment needs ~12s before the catalog registers. `/api/provider` returns only *activated* providers, never the full catalog. Activation via config requires the singular `provider` key with `options.apiKey` — the plural `providers` + `settings` form does **not** activate. Plugin loading itself is also async (an empty `/api/plugin` at t+8s is normal; plan for 10–20s).

**Theme.** V2 `ctx.theme` is nested tokens; the V1 flat keys are adapted in `src/tui.tsx` (`text.base`/`text.muted`/`text.feedback.{warning,error}.base`). `text.action.primary.base` is near-white (238,238,238) in the shipped dark theme, so the bar/labels use the Oracle agent orange `#FF8C00` (user decision 2026-09-25; agent frontmatter `color`, verified identical).

**Smoke/fence closure (2026-09-25).** The V2 smoke uses the same dual-entry shell: package-root `index.ts` forwards to `tests/smoke/server-entry.ts` (mock fetch lives on the **server** side since the port), `./tui` forwards to `tests/smoke/entry.tsx` (production renderer, zero mocks). Cold-start hygiene: the controller retries provider refresh (15s × 4) until a channel is ready; the TUI assertion window is 60s (home) / 90s (sidebar). Process hygiene: a V2 TUI spawns a background service bound to port **49374**; if that port is occupied by a leftover service the TUI hangs at "Starting background server…" forever — the smoke finally-block now reaps every opencode process whose cwd is inside the isolated root (multi-round, respawn-safe). Fence is four-step green with smoke at ~19s. Known backlog: GPT OAuth synthetic injection for smoke (V1 injected a mock OAuth; the V2 `ctx.integration.connect` oauth form is unverified), manual refresh command (needs keymap inside render), session-switch/theme/narrow-screen steps (V2 keybind synthesis).

Until the port lands this repository targets 1.x only → **superseded: the repository now targets 2.x only** (1.x host paths remain in git history).

## Host & paths

- The only restricted SDK read is `client.getConfig().baseUrl`, which must be exactly `http://opencode.internal`, followed by a health-version check. localhost is not proof of local mode; a failed check prevents any credential reads or remote requests.
- Cache = absolute `$XDG_STATE_HOME/opencode/channel-quota`, default `~/.local/state/opencode/channel-quota`. Sanitized snapshots only, identity-isolated by SHA-256, directory 0700 / files 0600, max age 7 days. Multiple local TUIs each keep their own schedule and cache; nothing shared is accumulated.
- The plugin no longer reads the host database: the local spend statistics module (v1 `message` metadata aggregation in a read-only worker, `OPENCODE_DB` disambiguation, `database_*` error states) was removed wholesale in the 2026-09-16 round. Git history retains the previous semantics.

## Channels & auth

| Channel | Support | Limits |
|---|---|---|
| GLM (China) | `zhipuai-coding-plan` with a host-effective API key | `open.bigmodel.cn` only; plain zhipuai or international GLM not included |
| OpenAI | connected openai + valid local native OAuth + accountId | API key / wellknown cannot query subscription quota; `source=custom` on native OAuth-only is not by itself a rejection |
| DeepSeek | `deepseek` with a host-effective API key | `api.deepseek.com` only; balance currencies kept as-is |

Custom sources for GLM/DeepSeek, unofficial models/baseURLs or per-model auth overrides are rejected; OpenAI cannot bypass the OAuth/official-endpoint restrictions through a custom source either. No environment-variable key fallback. When an API key file changes but the host snapshot has not, the old identity is hidden with a restart hint instead of impersonating the effective connection with the new file key. OAuth reads access/expires/accountId only — no proactive refresh, no refresh through model calls.

The GLM monitor endpoint and the OpenAI wham endpoint are unofficial, unstable contracts; the GLM unit=3/6 mapping to 5-hour/week windows comes from community research and **has not been verified against a real account**. Unknown fields degrade conservatively; an unknown window is never presented as a 5-hour window; failures or missing data are never interpreted as unlimited or zero. GET only — no UA spoofing, no `/responses`, no `/oauth/token` or other token probes.

## Display semantics

- The sidebar shows per-channel horizontal bars (█/░, fill length encodes progress) with the raw percentage (values above 100 shown as-is) and a compact English reset countdown (`reset in 1h5m`, `due, refresh`, `reset unknown`).
- Remote quotas, balances and errors each keep their own state; nothing is converted, merged or extrapolated. A reset countdown reaching zero does not clear the used percentage.
