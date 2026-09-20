# OpenCode Quota

A read-only quota sidebar plugin for **Linux / OpenCode 1.x (tested on 1.18.30 / 1.18.31) / the standard local TUI**. Self-contained, no machine-local path dependencies, portable to other Linux machines. Acceptance status is documented in [docs/acceptance.md](docs/acceptance.md); type checks and simulated UI do not prove real provider authentication.


## Status: waiting for OpenCode 2.x TUI plugin UI surface

This build (0.0.2) targets OpenCode 2.x with the unified `{id, setup}` plugin protocol.
As of 2.0.10/2.0.11 beta, the TUI plugin context exposes no UI rendering domains
(no slots/theme/toast — verified by runtime probing). The sidebar UI cannot mount yet.

- Credential chain (`provider.list` → settings.apiKey) and quota-fetch business layer are verified working against 2.0.11.
- TUI-internal slots/markdown registration infrastructure is present in the binary but not yet wired to the plugin context — adaptation is expected to be quick once the UI surface opens.
- Until then, this package stays a protocol-transition build and is not mountable.

## Features

- The session sidebar automatically shows GLM Coding Plan and GPT Pro20x subscription windows plus the DeepSeek balance, with the subscription tier as a name suffix (`GLM Coding Plan (Max)` / `GPT Pro20x (Pro)`; hidden when the value is unknown).
- The Quota block is appended after the native Context/MCP/LSP/Todo/Files blocks; subscription quotas use a horizontal character bar (█ filled + ░ base, width 16) with the percentage and a reset countdown. Progress is encoded by fill length and stays readable in monochrome. Click the Quota title row to collapse/expand (▾/▸); the collapsed state is kept in-process only.
- Normal-state noise stays hidden (per-channel "Updated" label, remote update time, command hints); necessary warnings (cached/stale, auth errors, unavailable, account unavailable) are never hidden.
- `/quota-refresh` re-detects credentials and refreshes remote quotas. It is a local command and never sends a model prompt.
- Refresh on startup and every 15 minutes, with independent cached / stale / error / not-connected states. A failure never impersonates a zero balance, and a countdown reaching zero never clears the used percentage.
- International GLM is not supported and not displayed.

> Removed in this version: the local spend statistics feature (estimated day/week/month USD from the local message database) and the `/quota` details page. They are recoverable from git history.

## Install / Uninstall

Source of the code: `git clone https://github.com/jiazhousa/OpenCodeQuota` (branch `main`, local dev branch `develop` pushes there) or a release source archive from <https://github.com/jiazhousa/OpenCodeQuota/releases>.

1. Place this repository at a **long-lived absolute path** and run `npm ci` inside it. Node/npm only install the pinned dev dependencies; Bun is provided by a project devDependency — no global Bun needed. `npm ci` is required: the TSX imports `@opentui/*` / `solid-js` at runtime and they resolve from this directory's `node_modules`.
2. Run `npm run typecheck`. Distribution is source code, there is no `dist`; do not load the source TSX as an npm package and do not bundle a second Solid/OpenTUI runtime.
3. In your own `tui.json` (default `~/.config/opencode/tui.json`; adjust for custom XDG paths), **append** the plugin entry at the root level and keep existing plugin entries and other settings. Example:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["file:///<absolute path of this repo on your machine>/src/tui.tsx"]
   }
   ```

   The above is a structural example — do not overwrite your existing file. The entry must be `src/tui.tsx`; **never install `tests/smoke/entry.tsx`**. Keep the source directory and its `node_modules` permanently; do not point at a directory that will be cleaned up.

## Migrating to a new machine

Requirements: Linux, OpenCode 1.x (standard local TUI), Node.js + npm (only for `npm ci`; Bun comes from the project devDependency).

1. Move the whole repository to a long-lived path on the new machine: `git clone <your remote>`, copy the directory (you may drop `node_modules/` and `test-fence-reports/` first), or use a single-file bundle: `git bundle create opencode-quota.bundle develop`, then `git clone opencode-quota.bundle opencode-quota`.
2. Run `npm ci` in the repository, then `npm run typecheck` to confirm integrity.
3. Configure the new machine's `tui.json` as above (file URL pointing at the new absolute path) and restart OpenCode.
4. No credentials to migrate: the plugin reuses providers already connected in the new machine's host (GLM Coding Plan key / DeepSeek key / OpenAI OAuth); finish connecting via `/connect`.
5. Exit and restart OpenCode, open a session and show the sidebar (host default keybind `<leader>b`). No plugin options to fill in, no extra keys to store.

Uninstall: remove the plugin entry, exit and restart. Do not delete host auth or databases. Optionally clean the plugin's own cache at `$XDG_STATE_HOME/opencode/channel-quota` (default `~/.local/state/opencode/channel-quota`).

## Support boundaries & safety

- Not supported: attach mode, explicit network transports, other host versions, custom proxy domains, third-party auth takeover. When the local environment cannot be confirmed, no credentials are read.
- Credentials are read-only: no OAuth refresh, no writes to host auth, no `/responses` or other model probes. Re-authenticate through the host when OAuth expires; API key changes may require a host restart to take effect.
- Local spend statistics were removed in this version; the plugin no longer opens the host database at all.
- Remote amounts keep their original currency; no FX conversion, no mixing of quota and balance figures.
- See [docs/compatibility.md](docs/compatibility.md) for path resolution, channel/auth restrictions and unofficial-API limits.

## Development & verification

```bash
npm run typecheck
npm run test:unit -- tests/unit tests/ui   # core cases: parsers / credentials / mount & rendering
# run only by the closing orchestrator:
npm run smoke -- --opencode /absolute/path/to/opencode
npm run fence -- --opencode /absolute/path/to/opencode
```

smoke requires Linux, tmux and the real target binary; it installs no system tools and reads no real accounts. `npm run build` equals the type check; `npm test` is the remaining core unit/UI set; `fence` runs build, core tests and the synthetic-credential smoke against a real host, in order.

## Publishing notes (for public distribution)

- The current distribution form is **TSX source + file URL** (the host's Bun compiles on the fly). To publish on npm for a one-line `plugin: ["<package>"]` install, add a **precompiled TSX artifact** first (build `dist/*.js` and point package.json at it) — the host loads from the npm cache differently than from a local file URL. This is the main pre-publish work item.
- The official community list (opencode.ai/docs/ecosystem) is a free PR to the `anomalyco/opencode` repo with human review; npm publishing is also free with an npm account.
- This plugin reads host credentials (read-only); for public distribution the safety boundary section above is the core trust material.
