# picc-loop

[![npm downloads](https://img.shields.io/npm/dt/@ladbabynpm/picc-loop.svg)](https://www.npmjs.com/package/@ladbabynpm/picc-loop)

Claude Code style cron scheduling for pi.
Part of [picc](https://github.com/Ladbaby/picc), a pi agent setup mirroring Claude Code's harness.
Adds `CronCreate` / `CronDelete` / `CronList` tools and a `/loop` slash command to pi.
Behavior, tool schemas, prompt text, cron semantics, jitter, auto-expiry, and cross-session leader election mirror Claude Code's `ScheduleCronTool` (`tools/ScheduleCronTool/prompt.ts`, `CronCreateTool.ts`, `CronDeleteTool.ts`, `CronListTool.ts`), `utils/cron.ts`, `skills/bundled/loop.ts`, and `utils/cronScheduler.ts` + `cronTasksLock.ts` — see the in-line section markers in `index.ts` for which Claude Code module each section was ported from.

Fork of `npm:@trevonistrevon/pi-loop`, where we replicate Claude Code's harness more faithfully.

## Tools registered

| Tool | Purpose |
|------|---------|
| `CronCreate` | Schedule a prompt to be enqueued at a future time — recurring on a 5-field cron schedule, or one-shot at a specific time. |
| `CronDelete` | Cancel a job by the ID returned from `CronCreate`. |
| `CronList` | List all cron jobs — durable (`.pi/scheduled_tasks.json`) plus session-only. |

`/loop` slash command: run a prompt or slash command on a recurring interval (e.g. `/loop 5m /foo`, defaults to `10m`). Mirrors Claude Code's `skills/bundled/loop.ts` — it injects a meta-prompt that instructs the model to call `CronCreate`, confirm the schedule, and immediately execute the prompt once without waiting for the first fire.

`Monitor` tools, task backlog, native task fallback, RPC, and the status widget from Claude Code are **intentionally NOT registered** (single-file trade-offs).

## Usage

Install via `pi install npm:@ladbabynpm/picc-loop`.

## `CronCreate` parameters

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `cron` | string | (required) | Standard 5-field cron in local time: `M H DoM Mon DoW` (e.g. `*/5 * * * *` = every 5 min, `30 14 28 2 *` = Feb 28 at 2:30pm local once). Supports wildcards, `N`, `*/N` steps, `N-M` ranges, comma-lists. Day-of-week accepts `7` as a Sunday alias. |
| `prompt` | string | (required) | The prompt to enqueue at each fire time. Delivered wrapped in a backtick fence one longer than the longest run of backticks in the body (matches Claude Code) so the model doesn't re-interpret it. |
| `recurring` | bool | `true` | `true` = fire on every cron match until deleted or auto-expired after 7 days. `false` = fire once at the next match, then auto-delete (one-shot). |
| `durable` | bool | `false` | `true` = persist to `.pi/scheduled_tasks.json` and survive restarts. `false` (default) = in-memory only, dies when this Pi session ends. Use `true` only when the user asks the task to survive across sessions. |

Max `50` concurrent jobs (`MAX_JOBS`). Job IDs are `randomUUID()` values.

Cron semantics match Claude Code / vixie-cron:

- Standard OR semantics when both day-of-month and day-of-week are constrained (either match fires).
- Next-run search walks forward minute-by-minute, bounded at 366 days; a cron that matches no date in the next year is rejected at creation.
- DST: fixed-hour crons targeting a spring-forward gap skip the transition day; fall-back repeats fire once.

### Fire behavior

- Jobs only fire while the REPL is idle (not mid-query); a busy agent defers the fire and retries.
- Delivery is `sendMessage` with `deliverAs: "steer", triggerTurn: true` on the root session's api.
- `lastFiredAt` is advanced only on successful delivery — a failed fire re-arms in place so the schedule doesn't shift.
- Stale-context delivery failures attempt recovery by rebinding to the most recent live session's api.
- Recurring jobs auto-expire **7 days** after creation (`DEFAULT_MAX_AGE_DAYS`): they fire one final time, then are deleted with a notice.
- One-shot durable tasks that were missed while the REPL was closed are surfaced for catch-up at reload; missed one-shots that already passed their fire time are deleted with a notice.

## Configuration

No configuration or environment variables. Constants in `index.ts` (not overridable):

| Constant | Value | Effect |
|----------|-------|--------|
| `MAX_JOBS` | `50` | Hard cap on concurrent scheduled jobs per project. |
| `DEFAULT_MAX_AGE_DAYS` | `7` | Recurring jobs auto-expire this many days after creation. |
| `DEFAULT_LOOP_INTERVAL` | `10m` | Interval used by `/loop` when none is given. |
| `LOCK_PROBE_INTERVAL_MS` | `5000` | How often each session probes the leader lock. |
| `LOCK_STALENESS_THRESHOLD_MS` | `30000` | Locks not refreshed within this window are considered stale and stealable (6× probe interval). |

## Storage (Claude Code parity)

Per-project disk file at `<cwd>/.pi/scheduled_tasks.json` (atomic temp+rename writes), matching Claude Code's `scheduled_tasks.json` convention. Runtime-only fields (`durable`, `nextRun`, `fireAttempts`, `lastDeliveryResult`) are stripped before write; file-backed tasks are durable by definition.

Inside `<cwd>/.pi/`:

- `scheduled_tasks.json` — persisted jobs (only written when at least one durable job exists).
- `scheduled_tasks.lock` — O_EXCL lock file for cross-session leader election.

Session-only (`durable: false`) jobs live in memory only and are discarded on `session_shutdown`.

## Cross-session wakeup (leader election)

There is no OS-level scheduler, daemon, or background service. The schedule is owned by whichever pi process is currently active in this project — elected via an O_EXCL file lock at `<cwd>/.pi/scheduled_tasks.lock`, matching Claude Code's `cronTasksLock` design.

- On `session_start`, the binding session tries to acquire the lock; the winner becomes the **leader** and arms all timers (a 1s tick loop plus per-job timers).
- Passive peers probe every 5s; if the lock hasn't been refreshed in 30s (crashed owner), a peer steals it and takes over.
- On `session_shutdown`, the leader releases the lock so the next running session in this cwd takes over within ~5s.
- Only the root session's api is used for delivery; subagent sessions (which share the extension runtime) never clobber the scheduler binding — secondary sessions are detected by API identity, not env vars.

So the schedule stays alive **only while at least one pi process is running in this cwd** — open `pi` (interactive REPL) or run `pi -p "..."` (print mode) at least once within the job's interval. If no process is running and the interval elapses, recurring jobs re-anchor to the next future occurrence and missed one-shots are deleted (or surfaced for catch-up) on next launch.

## Differences from Claude Code

These are intentionally out of scope for picc-loop.

- **Storage path**: `<cwd>/.pi/scheduled_tasks.json` (pi convention) instead of Claude Code's `.claude/scheduled_tasks.json`.
- **Single file**: no module split; scheduler, cron parser, and `/loop` meta-prompt all live in `index.ts`.
- **Monitor tools, task backlog, native task fallback, RPC, status widget**: all dropped.
- **Session branching**: not reconstructed from `ctx.sessionManager.getBranch()` — known limitation.
- **`durable` default**: `false` (session-only), matching Claude Code's default.
