# OpenCode Quota — Development Conventions

## Module responsibilities

- `src/core/contracts.ts`: shared contracts for the three channels, sanitized state, errors, Clock and service ports; coordinate with the orchestrator before cross-block changes.
- `src/providers/`: host-effective credential resolution, official GETs, parsers, identity-isolated cache, retry and refresh scheduling. Raw auth/Provider/HTTP exceptions must never reach the UI.
- `src/runtime/`: local/version verification and the controller lifecycle (provider scheduling, 30s `now` tick for reset countdowns, manual refresh, dispose).
- `src/ui/`, `src/tui.tsx`: production sidebar, the single `/quota-refresh` command and host mounting; consumes safe snapshots only, uses the host's Solid/OpenTUI identity.
- `tests/`: synthetic fixtures, unit and rendering tests; `tests/smoke/entry.tsx` only replaces the production factory's remote fetch and must never be installed.
- `scripts/`: credential-free smoke and the unified fence; failures are never skipped or faked.
- Removed in the 2026-09-16 round: `src/spend/` (local spend statistics worker) and `src/ui/Details.tsx` (the `/quota` details page). Recoverable from git history; do not reintroduce without a new task brief.

## Language conventions

- UI copy and user-facing strings (sidebar, toasts, command titles, error messages): English, from the static maps in `src/core/contracts.ts` / `src/ui/format.ts` — never concatenate provider, SDK or auth-file detail into them.
- Code comments and internal test/smoke report labels: Chinese; preserve existing comments.

## Minimal verification

- All source/test/script changes: `npm run typecheck`.
- Per changed block add: `npm run test:unit -- tests/unit/<file>.test.ts`; for UI, `tests/ui/quota.test.tsx`.
- Do not expand to full runs/E2E/fence on your own; the orchestrator runs `npm run fence -- --opencode /absolute/path/to/opencode` and checks `test-fence-reports/summary.txt`.
- No unauthorized commit/push, no global-config changes, no reading real auth/DB/config, no real provider requests.
- Pinned dependencies and file-URL source distribution; do not upgrade versions, add dependencies or bundle a second runtime on your own. `skipLibCheck` only suppresses third-party declaration conflicts and is not a mount verification.

Development-process archives (spec/impl/review reports) live in the developer's internal workbench `.specpipe/` and are not a runtime dependency of this repository. Compatibility and acceptance limits: `docs/compatibility.md`, `docs/acceptance.md`. Past real-GET checks were one-time authorizations; real queries are never part of automated fence, and later agents must not widen historical authorization into arbitrary credential reads, model requests or permanent integration rights.
