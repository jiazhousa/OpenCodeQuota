# Acceptance Notes & Operations Manual

## Status and evidence boundary

The 2026-09-16 streamlining round removed the `/quota` details page and the local spend statistics module, and switched all UI copy to English. Automated coverage is now 9 core tests (4 parsers / 3 credentials / 2 mount-render). This file describes the reproducible acceptance method; it is **not a pre-issued PASS certificate**.

- Historical evidence (kept for traceability, not proof of the current code): full unit/UI suites and real-host smoke runs from earlier rounds are archived under `test-fence-reports/` (e.g. `smoke-2SbmkR`, `fence-qpGcmH`) and in the workbench workflow archive; they covered versions that still contained the spend module.
- After this round, smoke has 9 checks (the "quota details & ESC" step was removed together with the details page; the narrow-screen step now covers theme switching and sidebar hide/restore only).
- The gate requires both the Checker review and the current-round fence to PASS. Anything not run, missing dependencies, timeouts, mount failures, field mismatches or leaks is a blocker; acceptance steps must not be trimmed to claim a pass.

## Commands and dependencies

Run from the root of the long-lived source repository, `npm ci` first. Node/npm and the in-project Bun are existing dependencies; the extra tools are Linux **tmux** and `/usr/bin/env`, plus a target OpenCode 1.x.y binary.

```bash
npm run typecheck
# run only by the closing orchestrator (not inside individual dev tasks):
npm run smoke -- --opencode /absolute/path/to/opencode
npm run fence -- --opencode /absolute/path/to/opencode
```

`--opencode` may be omitted; the script then only looks up `opencode` on PATH and fails non-zero if absent. When passed, it must be an absolute path. No keys, auth files, DB paths or mock switches are accepted as arguments. `/tmp/opencode` must already exist as a normal directory.

fence runs `npm run build` (180s budget), `npm test` (300s) and `bun scripts/smoke.ts` (300s) in order. A failed prerequisite marks later steps `NOT_RUN` and the run fails; a smoke timeout is SIGTERM + 15s grace, then SIGKILL — a forced kill is still a failure.

## What smoke actually does

1. Creates `home/config/data/state/cache/project/tmp` (0700) under `/tmp/opencode/channel-quota-smoke-<random>`; synthetic configs are 0600. Everything the run writes stays inside that directory except the redacted report.
2. **Allowlist-rebuilds** the child environment: PATH, fixed UTF-8 locale/TERM, temp HOME/OPENCODE_TEST_HOME, four XDG dirs, TMPDIR, fixed SHELL, plus script-generated auth content and isolation/no-update flags. The parent env is never expanded; provider keys, SSH and `OPENCODE_CONFIG*` are not inherited.
3. Declares the single test plugin via a file URL in a temp global config; the model catalog is a small generated fixture — no real model cache, no network catalog updates. An isolated `serve` verifies via `/provider` that GLM config / DeepSeek env+api / OpenAI OAuth-only custom credentials resolve correctly.
4. Creates the Alpha/Beta sessions via loopback `POST /session` (no prompts), inserts two synthetic assistant metadata rows into the temp v1 `message` table and one synthetic todo, and records the message-table signatures as the baseline.
5. Starts the real host in an isolated random tmux socket (PTY wrapper records the true exit code). The 160x80 session must show — without any command — the three channels, the horizontal █/░ bars with percentages and English reset countdowns, `Balance USD …`, and the synthetic todo; native Context/Todo blocks must render above Quota; the sidebar must contain no redundant normal-state text or command hints; startup must be exactly three mock GETs.
6. Submits `/quota-refresh` only once the registered local slash suggestion appears (menu-row evidence otherwise). All three channels must be re-queried exactly once each; the "Quota refreshed" toast must appear.
7. Uses temp keybinds (F6 sidebar, F7 session list, F8 theme, F10 exit): switch to Beta, hide/restore the sidebar, switch dark/light theme with real color-sequence evidence, verify narrow widths (42/24) stay stable with the sidebar hidden, then restore 160x80.
8. The host must exit with code 0 and no signal; the reopened read-only DB must match the baseline signatures (no messages added or modified). Requests must be exactly the three official GETs, twice each; anything else is rejected — no `/oauth/token`, no `/responses`, no model probes.
9. Scans captured frames, isolated host logs and the plugin cache for the synthetic secret/account sentinels. Any leak is a FAIL; persisted reports are redacted first, and **redaction is not an approval**.
10. Cleans up this run's serve PID and this run's tmux socket only; no `pkill opencode`, no touching other tmux servers. Deletion re-verifies the `/tmp/opencode` prefix, realpath and uid; unconfirmed cleanup is a FAIL.

The smoke entry only calls `createQuotaPlugin({ fetch: mockFetch })`; production Sidebar/controller/host bindings/credential reads stay real. No global fetch monkeypatching, no fake host API, no hand-drawn frames, no user-reachable mock mode.

## Artifacts and failure handling

- Standalone smoke: `test-fence-reports/smoke-<random>/summary.txt`, dependency/provider-contract notes, the static request audit, zero-message-change conclusion, redacted host log / plugin cache, and real `capture-pane` `.txt` / colored `.ansi` frames.
- Frames are real terminal text captures; no PNGs are generated or claimed. On failure the last real frame is saved when possible; no substitute is drawn.
- fence: `test-fence-reports/fence-<random>/{build,unit-ui,smoke}.log` plus a summary; the root `test-fence-reports/summary.txt` is updated atomically with the target version, exit codes, durations and PASS/FAIL/NOT_RUN per step. RUNNING never reuses an old PASS.
- Reports prove only the run they came from. Old reports do not prove new changes.
- If the host migrates schemas or TSX/native dependency loading breaks, escalate to the orchestrator — never "fix" by replacing production components, faking the DB, or skipping steps.

## Automated regression coverage

| Area | Core tests (user decision: keep only core cases) |
|---|---|
| Three-channel parsing (GLM CREDIT_LIMIT / OpenAI windows / DeepSeek currencies) | `tests/unit/quota-parsers.test.ts` (4) |
| Credential priority / OAuth read-only / expired never requested | `tests/unit/credentials.test.ts` (3) |
| Plugin registration & sidebar rendering (bars / collapse / channel names / English copy) | `tests/ui/quota.test.tsx` (2) |

Earlier rounds trimmed nine fine-grained unit files and extra UI cases by user instruction; the spend-aggregate tests were removed with the spend module in this round. History lives in git and the workbench workflow archive. Real-credential probing is never part of automated acceptance; any new real-world verification needs its own recorded authorization, date and redacted evidence.
