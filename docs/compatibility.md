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

## OpenCode 2.x status (verified feasible, port not yet shipped)

OpenCode 2.0.16 shipped a complete CLI-plugin channel; feasibility was verified by probe on 2026-09-24 (full evidence: OpenCodePipe repo `.specpipe/plans/ocp-plugin-dual-compat/experiment-record.md`, 2026-09-25 section):

- TUI plugins load only as a package directory `plugins/<name>/` containing `package.json` exporting `"./tui"` plus a `tui.tsx` entry; single-file mounts and config-declared (`cli.json`/`opencode.json` `plugins`) entries are not loaded by the TUI. `index.ts` beside `tui.tsx` is consumed by the server side.
- The TUI plugin context exposes `ui.slot({ append: "sidebar.content", render })`. `render` must return an OpenTUI component (`<text>`/`<box>`); a bare string crashes the TUI with an Orphan text error.
- Known layout paths: `sidebar.content` (sidebar position), `sidebar.footer`, `session.panel`, `session.composer.top`, `home.footer`(`.status`), `prompt.footer`(`.file`/`.status`). A bare target like `"sidebar"` is claimed silently but never rendered.

Until the port lands this repository targets 1.x only. The 2.x port backlog: package-layout mount, host probe adaptation (version gate widened to 2.x, ctx shapes, storage paths), slot-based sidebar rendering reusing the existing Solid components.

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
