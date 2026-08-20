/**
 * picc-loop — CronCreate / CronDelete / CronList + /loop slash command.
 *
 * Replaces npm:@trevonistrevon/pi-loop with a focused single-file extension
 * that matches Anthropic's Claude Code `/loop` cron design.
 *
 * Adapted from Claude Code (MIT license):
 *   - tools/ScheduleCronTool/{prompt.ts, CronCreateTool.ts, CronDeleteTool.ts, CronListTool.ts}
 *   - utils/cron.ts  (5-field parser, computeNextCronRun, cronToHuman)
 *   - skills/bundled/loop.ts  (/loop command + meta-prompt)
 *   - utils/cronScheduler.ts + cronTasksLock.ts  (leader-election via O_EXCL file lock)
 *
 * Divergences from Claude Code (single-file trade-offs):
 *   - Storage: per-project disk file at <ctx.cwd>/.pi/scheduled_tasks.json (atomic temp+rename).
 *   - Leader election: one pi process per project owns the schedule at a time via
 *     <cwd>/.pi/scheduled_tasks.lock (O_EXCL). Passive peers probe every 5s and
 *     steal stale locks. Matches Claude Code's cronTasksLock design.
 *   - Monitor tools, task backlog, native task fallback, RPC, status widget: all dropped.
 *   - Session branching: not reconstructed from ctx.sessionManager.getBranch() — known limitation.
 *
 * No external dependencies beyond pi's bundled @earendil-works/* packages and typebox
 * (which is bundled with pi).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, statSync, unlinkSync, utimesSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// §2 Constants
// ---------------------------------------------------------------------------

const MAX_JOBS = 50;
const DEFAULT_MAX_AGE_DAYS = 7; // recurring jobs auto-expire this many days after createdAt; enforced in onFire
const DEFAULT_LOOP_INTERVAL = "10m";
const ONE_YEAR_MS = 366 * 24 * 60 * 60 * 1000;

// Leader-election for cross-session cron ownership. Only one pi process per
// project runs the timer chain at a time. The lock holder (the "leader")
// refreshes the lock file's mtime every probe tick; passive peers try to
// steal it if it has gone stale. This way the schedule survives session
// restarts without an OS-level scheduler or background daemon.
const LOCK_PROBE_INTERVAL_MS = 5_000;
const LOCK_STALENESS_THRESHOLD_MS = 30_000; // 6× probe interval; reclaim crashed-owner locks

const TOOL_CRON_CREATE = "CronCreate";
const TOOL_CRON_DELETE = "CronDelete";
const TOOL_CRON_LIST = "CronList";

// ---------------------------------------------------------------------------
// §3 Cron utilities — full port of utils/cron.ts
// ---------------------------------------------------------------------------

type CronFields = {
	minute: number[];
	hour: number[];
	dayOfMonth: number[];
	month: number[];
	dayOfWeek: number[];
};

type FieldRange = { min: number; max: number };

const FIELD_RANGES: FieldRange[] = [
	{ min: 0, max: 59 }, // minute
	{ min: 0, max: 23 }, // hour
	{ min: 1, max: 31 }, // dayOfMonth
	{ min: 1, max: 12 }, // month
	{ min: 0, max: 6 }, // dayOfWeek (0=Sunday; 7 accepted as Sunday alias)
];

// Parse a single cron field into a sorted array of matching values.
// Supports: wildcard, N, star-slash-N (step), N-M (range), and comma-lists.
// Returns null if invalid.
function expandField(field: string, range: FieldRange): number[] | null {
	const { min, max } = range;
	const out = new Set<number>();

	for (const part of field.split(",")) {
		// wildcard or star-slash-N
		const stepMatch = part.match(/^\*(?:\/(\d+))?$/);
		if (stepMatch) {
			const step = stepMatch[1] ? parseInt(stepMatch[1], 10) : 1;
			if (step < 1) return null;
			for (let i = min; i <= max; i += step) out.add(i);
			continue;
		}

		// N-M or N-M/S
		const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
		if (rangeMatch) {
			const lo = parseInt(rangeMatch[1]!, 10);
			const hi = parseInt(rangeMatch[2]!, 10);
			const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;
			// dayOfWeek: accept 7 as Sunday alias in ranges (e.g. 5-7 = Fri,Sat,Sun → [5,6,0])
			const isDow = min === 0 && max === 6;
			const effMax = isDow ? 7 : max;
			if (lo > hi || step < 1 || lo < min || hi > effMax) return null;
			for (let i = lo; i <= hi; i += step) {
				out.add(isDow && i === 7 ? 0 : i);
			}
			continue;
		}

		// plain N
		const singleMatch = part.match(/^\d+$/);
		if (singleMatch) {
			let n = parseInt(part, 10);
			// dayOfWeek: accept 7 as Sunday alias → 0
			if (min === 0 && max === 6 && n === 7) n = 0;
			if (n < min || n > max) return null;
			out.add(n);
			continue;
		}

		return null;
	}

	if (out.size === 0) return null;
	return Array.from(out).sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression into expanded number arrays.
 * Returns null if invalid or unsupported syntax.
 */
function parseCronExpression(expr: string): CronFields | null {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return null;

	const expanded: number[][] = [];
	for (let i = 0; i < 5; i++) {
		const result = expandField(parts[i]!, FIELD_RANGES[i]!);
		if (!result) return null;
		expanded.push(result);
	}

	return {
		minute: expanded[0]!,
		hour: expanded[1]!,
		dayOfMonth: expanded[2]!,
		month: expanded[3]!,
		dayOfWeek: expanded[4]!,
	};
}

/**
 * Compute the next Date strictly after `from` that matches the cron fields,
 * using the process's local timezone. Walks forward minute-by-minute. Bounded
 * at 366 days; returns null if no match.
 *
 * Standard cron semantics: when both dayOfMonth and dayOfWeek are constrained
 * (neither is the full range), a date matches if EITHER matches.
 *
 * DST: fixed-hour crons targeting a spring-forward gap (e.g. `30 2 * * *`
 * in a US timezone) skip the transition day — the gap hour never appears
 * in local time, so the hour-set check fails and the loop moves on.
 * Wildcard-hour crons (`30 * * * *`) fire at the first valid minute after
 * the gap. Fall-back repeats fire once (the step-forward logic jumps past
 * the second occurrence). This matches vixie-cron behavior.
 */
function computeNextCronRun(fields: CronFields, from: Date): Date | null {
	const minuteSet = new Set(fields.minute);
	const hourSet = new Set(fields.hour);
	const domSet = new Set(fields.dayOfMonth);
	const monthSet = new Set(fields.month);
	const dowSet = new Set(fields.dayOfWeek);

	// Is the field wildcarded (full range)?
	const domWild = fields.dayOfMonth.length === 31;
	const dowWild = fields.dayOfWeek.length === 7;

	// Round up to the next whole minute (strictly after `from`)
	const t = new Date(from.getTime());
	t.setSeconds(0, 0);
	t.setMinutes(t.getMinutes() + 1);

	const maxIter = 366 * 24 * 60;
	for (let i = 0; i < maxIter; i++) {
		const month = t.getMonth() + 1;
		if (!monthSet.has(month)) {
			// Jump to start of next month
			t.setMonth(t.getMonth() + 1, 1);
			t.setHours(0, 0, 0, 0);
			continue;
		}

		const dom = t.getDate();
		const dow = t.getDay();
		// When both dom/dow are constrained, either match is sufficient (OR semantics)
		const dayMatches =
			domWild && dowWild
				? true
				: domWild
					? dowSet.has(dow)
					: dowWild
						? domSet.has(dom)
						: domSet.has(dom) || dowSet.has(dow);

		if (!dayMatches) {
			// Jump to start of next day
			t.setDate(t.getDate() + 1);
			t.setHours(0, 0, 0, 0);
			continue;
		}

		if (!hourSet.has(t.getHours())) {
			t.setHours(t.getHours() + 1, 0, 0, 0);
			continue;
		}

		if (!minuteSet.has(t.getMinutes())) {
			t.setMinutes(t.getMinutes() + 1);
			continue;
		}

		return t;
	}

	return null;
}

// --- cronToHuman ------------------------------------------------------------
// Intentionally narrow: covers common patterns; falls through to the raw cron
// string for anything else. Local scheduled tasks only — no utc option needed.

const DAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

function formatLocalTime(minute: number, hour: number): string {
	// January 1 — no DST gap anywhere. Using `new Date()` (today) would roll
	// 2am→3am on the one spring-forward day per year.
	const d = new Date(2000, 0, 1, hour, minute);
	return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function cronToHuman(cron: string): string {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return cron;

	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
		string,
		string,
		string,
		string,
		string,
	];

	// Every N minutes: */N * * * *
	const everyMinMatch = minute.match(/^\*\/(\d+)$/);
	if (
		everyMinMatch &&
		hour === "*" &&
		dayOfMonth === "*" &&
		month === "*" &&
		dayOfWeek === "*"
	) {
		const n = parseInt(everyMinMatch[1]!, 10);
		return n === 1 ? "Every minute" : `Every ${n} minutes`;
	}

	// Every hour: M * * * *
	if (
		minute.match(/^\d+$/) &&
		hour === "*" &&
		dayOfMonth === "*" &&
		month === "*" &&
		dayOfWeek === "*"
	) {
		const m = parseInt(minute, 10);
		if (m === 0) return "Every hour";
		return `Every hour at :${m.toString().padStart(2, "0")}`;
	}

	// Every N hours: 0 */N * * *
	const everyHourMatch = hour.match(/^\*\/(\d+)$/);
	if (
		minute.match(/^\d+$/) &&
		everyHourMatch &&
		dayOfMonth === "*" &&
		month === "*" &&
		dayOfWeek === "*"
	) {
		const n = parseInt(everyHourMatch[1]!, 10);
		const m = parseInt(minute, 10);
		const suffix = m === 0 ? "" : ` at :${m.toString().padStart(2, "0")}`;
		return n === 1 ? `Every hour${suffix}` : `Every ${n} hours${suffix}`;
	}

	// Remaining cases reference hour+minute
	if (!minute.match(/^\d+$/) || !hour.match(/^\d+$/)) return cron;
	const m = parseInt(minute, 10);
	const h = parseInt(hour, 10);
	const fmtTime = formatLocalTime;

	// Daily at specific time: M H * * *
	if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
		return `Every day at ${fmtTime(m, h)}`;
	}

	// Specific day of week: M H * * D
	if (dayOfMonth === "*" && month === "*" && dayOfWeek.match(/^\d$/)) {
		const dayIndex = parseInt(dayOfWeek, 10) % 7; // normalize 7 (Sunday alias) -> 0
		const dayName = DAY_NAMES[dayIndex];
		if (dayName) return `Every ${dayName} at ${fmtTime(m, h)}`;
	}

	// Weekdays: M H * * 1-5
	if (dayOfMonth === "*" && month === "*" && dayOfWeek === "1-5") {
		return `Weekdays at ${fmtTime(m, h)}`;
	}

	return cron;
}

// ---------------------------------------------------------------------------
// §4 Job store + scheduler
// ---------------------------------------------------------------------------

interface CronJob {
	id: string;
	cron: string;
	prompt: string;
	recurring: boolean;
	durable: boolean;
	createdAt: number;
	lastFiredAt?: number; // updated by onFire for durable recurring jobs
	timer?: NodeJS.Timeout;
	nextRun?: number;
	fireAttempts?: number; // in-memory only; counts every onFire call (delivered or not)
	lastDeliveryResult?: "ok" | "busy" | "stale-ctx" | "no-pi" | "error"; // in-memory only; for diag
}

// ---------------------------------------------------------------------------
// §4.1 Disk persistence types (matches Claude Code's scheduled_tasks.json shape)
// ---------------------------------------------------------------------------

/**
 * On-disk shape for a single cron task. Mirrors Claude Code's CronTask
 * (`utils/cronTasks.ts`), minus fields we don't use (agentId, permanent):
 *
 *   { id, cron, prompt, createdAt, lastFiredAt?, recurring? }
 *
 * `durable` and `expiresAt` are runtime-only and stripped before write.
 * File-backed tasks are durable by definition (Claude Code's convention);
 * 7-day expiry is computed at fire time from `createdAt`, not stored.
 */
type PersistedTask = {
	id: string;
	cron: string;
	prompt: string;
	createdAt: number;
	lastFiredAt?: number;
	recurring?: boolean;
};

type PersistedFile = {
	tasks: PersistedTask[];
};

// Module-level state. stateFile is set in session_start; null = no cwd yet
// (e.g. the tool is registered but no session has started, or the cwd is
// unavailable).
let stateFile: string | null = null;

// Per-session debug log file. Used to record picc-loop lifecycle events to
// disk, independent of stderr, so the user can `tail` / `cat` it to verify
// that the cron scheduler is actually running even if stderr is being
// suppressed or routed somewhere by the TUI / extension runner. The file
// lives next to scheduled_tasks.json and is overwritten at session_start
// (one file per session — the user can diff across runs if needed).
let debugLogPath: string | null = null;

function debugLog(line: string): void {
	if (!debugLogPath) return;
	try {
		const ts = new Date().toISOString();
		const pid = process.pid;
		appendFileSync(debugLogPath, `${ts} [pid=${pid}] ${line}\n`, "utf8");
	} catch {
		/* best-effort */
	}
}

// Leader-election state. `isLeader` is true for the process that owns the
// cron schedule (and runs the timer chain). `lockFd` is the open file
// descriptor for the O_EXCL lock file; we keep it open so the lock survives
// even if our session is busy. `probeTimer` is the 5s setInterval that
// drives both lock refresh (as leader) and steal attempts (as passive).
let lockPath: string | null = null;
let lockFd: number | null = null;
let isLeader = false;
let probeTimer: NodeJS.Timeout | null = null;

const MAX_AGE_MS = DEFAULT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

const jobs = new Map<string, CronJob>();
let currentPi: ExtensionAPI | undefined;
// Root session api captured from the FIRST session_start in this process.
//
// CRITICAL: pi-subagents (and any other spawner) creates in-process
// AgentSessions that share this module's singleton state. Each of those
// sessions fires our session_start/session_shutdown handlers with its OWN
// api. The shared extension runtime is permanently poisoned the moment ANY
// such session is disposed (AgentSession.dispose() -> ExtensionRunner
// .invalidate() -> runtime.invalidate() sets state.staleMessage with ??=,
// never cleared) — every api bound to that runtime then throws "This
// extension ctx is stale" on sendMessage, forever, for the whole process.
//
// To survive that, `currentPi` is pinned to the ROOT session's api and is
// only re-pinned when that binding dies (stale recovery). Subagent session
// starts/shutdowns can never clobber the scheduler's state: they are
// detected by api identity (currentPi !== pi) with no reliance on env vars
// (PI_SUBAGENT_CHILD is unreliable — it leaks into main sessions).
let rootPi: ExtensionAPI | undefined;
// Most recent session_start's api. Used by stale recovery: if rootPi's
// runtime was poisoned (session replacement / subagent teardown), rebind to
// the freshest session api that still probes alive.
let lastSessionPi: ExtensionAPI | undefined;
// Count of in-flight agent runs (agent_start++ / agent_settled--) across all
// sessions sharing this module. >0 means "an agent turn is running" — cron
// fires are deferred until it returns to 0, matching Claude Code's
// isLoading() gate in cronScheduler.check().
let agentBusyCount = 0;
// When the current busy window started. Guards against a stuck counter: if
// agent_settled is ever missed (e.g. a session is torn down mid-run), fires
// resume after MAX_BUSY_DEFER_MS anyway. Firing into a running turn is safe —
// sendCustomMessage queues via steer() during streaming — so this expiry is
// a starvation guard, not a correctness requirement.
let agentBusySince: number | null = null;
const MAX_BUSY_DEFER_MS = 30 * 60 * 1000;

function generateId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 8);
}

function computeNextRun(job: CronJob, anchorTime: Date = new Date()): number | null {
	const fields = parseCronExpression(job.cron);
	if (!fields) return null;
	const next = computeNextCronRun(fields, anchorTime);
	if (!next) return null;
	const ms = next.getTime() - Date.now();
	if (ms < 0) return null;
	// No jitter: recurring jobs fire exactly on their cron boundaries (the
	// same behavior as Claude Code's cronScheduler). Randomized fire times
	// were confusing for `*/N`-style loops — the delay between observed fires
	// drifted below the stated period and fire times landed at arbitrary
	// second offsets (e.g. 11:20:12 instead of 11:20:00). The lock-based
	// leader election already guarantees a single firing process, so there is
	// no thundering-herd concern that jitter was meant to spread.
	return Date.now() + ms;
}

// Compute the next absolute fire time for a job (without setting any timer).
// Used by both the initial arm path and the recurring tick path so they stay
// consistent. Returns null if no valid future match.
function computeNextRunForJob(job: CronJob): number | null {
	const anchor = job.lastFiredAt ?? job.createdAt;
	let next = computeNextRun(job, new Date(anchor));
	if (!next) {
		// No valid next-fire from historical anchor. For recurring jobs, try
		// re-anchoring from now (handles missed fires while pi was closed).
		// For one-shots, the caller handles past-due cleanup.
		if (job.recurring) {
			next = computeNextRun(job, new Date());
		}
	}
	return next;
}

// setInterval-based cron ticker. Fires every TICK_INTERVAL_MS, checks each
// job's nextRun, and dispatches to onFire when due. Replaces the prior
// per-job setTimeout chain, which had an observed failure mode where the
// timer did not fire under certain interactive-mode runtime conditions
// (likely an event-loop / unref interaction we could not pin down).
// setInterval is reliable: as long as the process is alive and the event
// loop ticks, every job will fire on time. The tick interval is small
// enough (1s) to keep fire latency under the user-perceptible threshold.
const TICK_INTERVAL_MS = 1000;
const BUSY_RETRY_INTERVAL_MS = 5_000;
const BUSY_LOG_THROTTLE_MS = 30_000; // re-log busy deferrals at most once per 30s
let lastBusyLogTime: number | null = null;
let tickTimer: NodeJS.Timeout | null = null;

function isAgentBusy(): boolean {
	if (agentBusyCount <= 0) return false;
	if (agentBusySince !== null && Date.now() - agentBusySince > MAX_BUSY_DEFER_MS) return false;
	return true;
}

// Probe whether an api's underlying extension runtime is still alive. Every
// action on the api calls runtime.assertActive(), which throws the stale
// error once the shared runtime was invalidated by a session dispose.
// getActiveTools() is a read-only, side-effect-free probe.
function probeAlive(api: ExtensionAPI | undefined): boolean {
	if (!api) return false;
	try {
		api.getActiveTools();
		return true;
	} catch {
		return false;
	}
}

function startTickLoop(): void {
	if (tickTimer) return;
	// Deliberately do NOT call .unref() on the tick loop. The cron scheduler
	// is a fundamental part of the user-facing promise ("jobs fire while pi
	// is open"). If we unref and the only other refs in the event loop are
	// also unref'd (e.g. during idle waiting), Node could exit early and kill
	// the schedule. The 1Hz tick is negligible in CPU; the keep-alive cost
	// is acceptable for the guarantee it provides.
	tickTimer = setInterval(tickJobs, TICK_INTERVAL_MS);
	// debugLog(`tick loop started (every ${TICK_INTERVAL_MS}ms, NOT unref'd)`);
}

function stopTickLoop(): void {
	if (!tickTimer) return;
	clearInterval(tickTimer);
	tickTimer = null;
	// debugLog(`tick loop stopped`);
}

function tickJobs(): void {
	const now = Date.now();
	for (const job of jobs.values()) {
		if (typeof job.nextRun !== "number") {
			// Job was loaded without a nextRun (shouldn't happen with current
			// scheduleTimer, but defensive). Compute on the fly.
			job.nextRun = computeNextRunForJob(job) ?? undefined;
			continue;
		}
		if (job.nextRun <= now) {
			// Fire. Re-compute nextRun after the fire so the next interval
			// has an accurate target.
			// debugLog(`tick: due ${job.id} (cron=${job.cron}, nextRun=${new Date(job.nextRun).toISOString()})`);
			onFire(job);
		}
	}
}

// Legacy per-job setTimeout arm. Kept for the case where the tick loop is
// not running (e.g. before startTickLoop is called) so we don't double-fire.
// scheduleTimer() now just computes nextRun; the tick loop dispatches.
function scheduleTimer(job: CronJob): void {
	if (job.timer) {
		clearTimeout(job.timer);
		job.timer = undefined;
	}
	const anchorIso = new Date(job.lastFiredAt ?? job.createdAt).toISOString();
	const next = computeNextRunForJob(job);
	if (!next) {
		// debugLog(`scheduleTimer(${job.id}): gave up; no valid next fire from anchor ${anchorIso}`);
		job.nextRun = undefined;
		return;
	}
	const delayMs = Math.max(0, next - Date.now());
	job.nextRun = next;
	// debugLog(`scheduleTimer(${job.id}): armed next fire at ${new Date(next).toISOString()} (in ${delayMs}ms, cron=${job.cron})`);
}

function onFire(job: CronJob): void {
	if (!jobs.has(job.id)) {
		// debugLog(`onFire(${job.id}): job not in map; skipping`);
		return;
	}

	job.fireAttempts = (job.fireAttempts ?? 0) + 1;
	const now = Date.now();

	// debugLog(
	// 	`FIRE attempt #${job.fireAttempts} for ${job.id} (${job.cron}); isLeader=${isLeader}, hasCurrentPi=${!!currentPi}, recurring=${job.recurring}, lastFiredAt=${job.lastFiredAt ? new Date(job.lastFiredAt).toISOString() : "never"}`,
	// );

	// 7-day auto-expiry for recurring jobs. Computed from createdAt at fire
	// time (not stored on disk), matching Claude Code's `isRecurringTaskAged`
	// check. Fire one last time, then delete.
	if (job.recurring && now - job.createdAt > MAX_AGE_MS) {
		deliverFire(job);
		jobs.delete(job.id);
		if (job.durable) persistJobs();
		try {
			currentPi?.sendMessage(
				{
					customType: "picc-loop-notice",
					content: `Recurring job ${job.id} auto-expired after ${DEFAULT_MAX_AGE_DAYS} days and was deleted.`,
					display: false,
				},
				{ deliverAs: "steer", triggerTurn: false },
			);
		} catch {
			/* best-effort */
		}
		return;
	}

	if (isAgentBusy()) {
		job.nextRun = Date.now() + BUSY_RETRY_INTERVAL_MS;
		job.lastDeliveryResult = "busy";
		// Throttle busy logs: while an agent run is in progress the tick loop
		// re-fires every 5s, which would otherwise spam one line per attempt.
		// Log the first deferral, then at most once per BUSY_LOG_THROTTLE_MS.
		const nowMs = Date.now();
		if (lastBusyLogTime === null || nowMs - lastBusyLogTime > BUSY_LOG_THROTTLE_MS) {
			lastBusyLogTime = nowMs;
			// debugLog(`FIRE attempt #${job.fireAttempts} for ${job.id}: agent busy; deferring ${BUSY_RETRY_INTERVAL_MS}ms`);
		}
		return;
	}

	const delivered = deliverFire(job);

	// If delivery failed, log it but ALWAYS re-arm the recurring timer.
	//
	// Rationale: the previous behavior was to clear the timer on any non-stale
	// failure (and on stale-ctx). This caused the symptom "fires once then
	// never again" if `currentPi` was lost mid-session for any reason other
	// than a clean session_replacement (e.g. transient runner/sendMessage
	// failures, race during dispose/recreate). Killing the timer permanently
	// forced the user to restart pi to resume the schedule, which is bad
	// UX. We now re-arm regardless of delivery result; if `currentPi` is
	// truly dead, every fire will fail the same way and the user will see
	// repeated errors in stderr, which is the desired signal.
	//
	// `lastFiredAt` is only advanced on successful delivery — a failed fire
	// should not reset the anchor and shift the entire schedule forward.
	if (!delivered) {
		// debugLog(
		// 	`FIRE attempt #${job.fireAttempts} for ${job.id} FAILED to deliver (lastDeliveryResult=${job.lastDeliveryResult}); will re-arm in place`,
		// );
		if (job.recurring) {
			// Re-arm without advancing lastFiredAt so the next cron match is
			// computed from the same anchor (matching Claude Code's behavior).
			scheduleTimer(job);
		} else {
			// One-shot: drop from in-memory map; tick loop will skip it.
			jobs.delete(job.id);
			if (job.durable) persistJobs();
		}
		return;
	}

	// debugLog(
	// 	`FIRE attempt #${job.fireAttempts} for ${job.id} delivered successfully (lastDeliveryResult=${job.lastDeliveryResult})`,
	// );

	if (job.recurring) {
		job.lastFiredAt = now;
		if (job.durable) persistJobs();
		scheduleTimer(job);
	} else {
		// One-shot: delete from in-memory map and (if durable) from disk.
		jobs.delete(job.id);
		if (job.durable) persistJobs();
	}
}

function clearAllTimers(): void {
	// Per-job setTimeout is now handled by the tick loop (setInterval). We
	// still clear any stale setTimeout handle for safety (e.g. if a job is
	// removed mid-flight) but the tick loop is the source of truth.
	for (const job of jobs.values()) {
		if (job.timer) {
			clearTimeout(job.timer);
			job.timer = undefined;
		}
	}
}

// Diagnostic helper: returns the smallest ms-until-next-fire across all
// currently-scheduled jobs, or 0 if there are no jobs / no nextRun set.
// Used by the session_start and leaderProbe stderr logs so the user can
// see at a glance when the next cron fire is expected.
function formatMsUntilNextFire(): number {
	let minMs = Number.POSITIVE_INFINITY;
	const now = Date.now();
	for (const job of jobs.values()) {
		if (typeof job.nextRun === "number" && job.nextRun > now) {
			const delta = job.nextRun - now;
			if (delta < minMs) minMs = delta;
		}
	}
	return Number.isFinite(minMs) ? Math.round(minMs) : 0;
}

// ---------------------------------------------------------------------------
// §4.1.1 Leader election — O_EXCL file lock + 5s probe
//
// The schedule is owned by exactly one pi process per project at any given
// moment. The leader holds <cwd>/.pi/scheduled_tasks.lock open; passive
// processes probe every LOCK_PROBE_INTERVAL_MS. If the lock file's mtime is
// older than LOCK_STALENESS_THRESHOLD_MS (e.g. the owner crashed), a passive
// peer steals it and becomes the new leader. This keeps the schedule alive
// across interactive session restarts without an OS-level daemon, and is the
// same pattern Claude Code uses (utils/cronScheduler.ts + cronTasksLock.ts).
// ---------------------------------------------------------------------------

function acquireLockOrStealStale(path: string): boolean {
	try {
		const fd = openSync(path, "wx");
		lockFd = fd;
		return true;
	} catch (err) {
		// EEXIST means someone else holds the lock. Steal it only if the
		// holder has gone stale (mtime older than threshold) — otherwise
		// another live pi session is doing the job.
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EEXIST") {
			// Unexpected OS error (EACCES, EPERM, EBUSY on Windows; often
			// caused by AV scanners, handle inheritance, or transient file
			// system hiccups). The file may or may not actually exist —
			// unlink defensively and try once more before giving up.
			try {
				unlinkSync(path);
			} catch {
				/* ignore — file may not exist */
			}
			try {
				const fd = openSync(path, "wx");
				lockFd = fd;
				return true;
			} catch {
				return false;
			}
		}
		try {
			const st = statSync(path);
			if (Date.now() - st.mtimeMs > LOCK_STALENESS_THRESHOLD_MS) {
				// Stale lock from a crashed owner. Unlink and retry once.
				try {
					unlinkSync(path);
				} catch (unlinkErr) {
					return false;
				}
				const fd = openSync(path, "wx");
				lockFd = fd;
				return true;
			}
		} catch (statErr) {
			// Lock disappeared between EEXIST and stat (very rare race). Try
			// to acquire cleanly.
			try {
				const fd = openSync(path, "wx");
				lockFd = fd;
				return true;
			} catch {
				return false;
			}
		}
		return false;
	}
}

function refreshLock(): void {
	// Touch the lock file's atime/mtime so passive peers see we're alive.
	// On NTFS, writeFileSync against an open O_EXCL fd does NOT reliably bump
	// mtime (the write may be coalesced/deferred); utimesSync on the path is
	// cross-platform and reliable. We do NOT touch the open fd — the O_EXCL
	// lock stays held for the lifetime of the process.
	if (!lockPath) return;
	try {
		const now = new Date();
		utimesSync(lockPath, now, now);
	} catch (err) {
	}
}

function releaseLock(): void {
	if (lockFd !== null) {
		try {
			closeSync(lockFd);
		} catch {
			/* best-effort */
		}
		lockFd = null;
	}
	if (lockPath) {
		try {
			unlinkSync(lockPath);
		} catch {
			/* tolerate already-gone */
		}
	}
}

function leaderProbe(): void {
	if (!lockPath) return;
	if (isLeader) {
		refreshLock();
		return;
	}
	// Passive: try to acquire (or steal) the lock.
	const acquired = acquireLockOrStealStale(lockPath);
	if (!acquired) return;
	// debugLog(`probe: stole stale lock; becoming leader`);
	isLeader = true;
	clearAllTimers();
	jobs.clear();
	loadJobsFromDiskAndSchedule();
	// debugLog(`probe: became leader, armed ${jobs.size} job(s); next fire in ${formatMsUntilNextFire()}ms`);
}

function startProbeLoop(): void {
	if (probeTimer) return;
	probeTimer = setInterval(leaderProbe, LOCK_PROBE_INTERVAL_MS);
	probeTimer.unref?.();
}

function stopProbeLoop(): void {
	if (!probeTimer) return;
	clearInterval(probeTimer);
	probeTimer = null;
}

function loadJobsFromDiskAndSchedule(): void {
	if (!stateFile) return;
	const loaded = loadTasksFromDisk(stateFile);
	const now = Date.now();
	let scheduled = 0;
	let dropped = 0;
	for (const pt of loaded) {
		// Skip one-shots that already fired (defensive — onFire should have removed them).
		if (!pt.recurring && typeof pt.lastFiredAt === "number") {
			dropped++;
			continue;
		}

		const job: CronJob = {
			id: pt.id,
			cron: pt.cron,
			prompt: pt.prompt,
			recurring: pt.recurring ?? false,
			durable: true, // file-backed tasks are durable by definition (Claude Code convention)
			createdAt: pt.createdAt,
			lastFiredAt: pt.lastFiredAt,
		};
		jobs.set(job.id, job);

		// One-shot: check if fire time is in the past before scheduling.
		// Recurring jobs are handled by scheduleTimer (which re-anchors from
		// lastFiredAt, and falls back to now if the computed next-fire is past-due).
		if (!job.recurring) {
			const fields = parseCronExpression(job.cron);
			const next = fields ? computeNextCronRun(fields, new Date(job.createdAt)) : null;
			if (!next || next.getTime() <= now) {
				// Past-due one-shot: delete without firing (matches Claude Code's
				// missed-task notification + deletion behavior).
				jobs.delete(job.id);
				dropped++;
				try {
					currentPi?.sendMessage(
						{
							customType: "picc-loop-notice",
							content: `Missed one-shot task ${job.id} (was due at ${next ? new Date(next.getTime()).toLocaleString() : "N/A"}); deleting.`,
							display: false,
						},
						{ deliverAs: "steer", triggerTurn: false },
					);
				} catch {
					/* best-effort */
				}
				continue; // skip scheduleTimer — job is deleted
			}
		}

		scheduleTimer(job);
		scheduled++;
		if (job.nextRun) {
		}
	}

	// debugLog(`loaded ${loaded.length} task(s) from ${stateFile}; scheduled ${scheduled}, dropped ${dropped}`);

	if (stateFile) persistJobs(); // persist deletions of missed one-shots
}

// ---------------------------------------------------------------------------
// §4.2 Disk I/O — atomic temp+rename, no file lock
// ---------------------------------------------------------------------------

function atomicWriteJson(filePath: string, data: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2));
	renameSync(tmp, filePath);
}

function loadTasksFromDisk(filePath: string): PersistedTask[] {
	if (!existsSync(filePath)) return [];
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) return [];
		const now = Date.now();
		return parsed.tasks.filter((t: any): t is PersistedTask => {
			if (!t || typeof t.id !== "string" || typeof t.cron !== "string") return false;
			if (typeof t.prompt !== "string" || typeof t.createdAt !== "number") return false;
			// Drop already-expired recurring tasks on load (matches Claude Code's
			// isRecurringTaskAged check at scheduler start).
			if (t.recurring && now - t.createdAt > MAX_AGE_MS) return false;
			// One-shots that have fired (lastFiredAt set) should have been removed
			// by onFire — but if a previous crash left them, drop them now.
			if (!t.recurring && typeof t.lastFiredAt === "number") return false;
			// Validate cron parses cleanly; otherwise drop.
			if (!parseCronExpression(t.cron)) return false;
			return true;
		});
	} catch (err) {
		return [];
	}
}

function persistJobs(): void {
	if (!stateFile) return;
	// Strip runtime-only fields. durable is implicit (file-backed = durable);
	// timer/nextRun/fireAttempts/lastDeliveryResult are in-memory only. Claude
	// Code strips durable via `tasks.map(({ durable: _durable, ...rest }) => rest)`;
	// we do the same plus timer/nextRun/fireAttempts/lastDeliveryResult.
	const persisted: PersistedTask[] = Array.from(jobs.values()).map(
		({ timer, nextRun, fireAttempts, lastDeliveryResult, durable: _durable, ...rest }) => rest,
	);
	try {
		atomicWriteJson(stateFile, { tasks: persisted });
	} catch (err) {
	}
}

// ---------------------------------------------------------------------------
// §5 Tool description / prompt text builders
// Adapted from Claude Code's tools/ScheduleCronTool/prompt.ts (non-durable
// variant), with the durability section rewritten to "session-only".
// ---------------------------------------------------------------------------

function buildCronCreateDescription(): string {
	return `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it

Every user who asks for "9am" gets \`0 9\`, and every user who asks for "hourly" gets \`0 *\` — which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" → "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." → pick whatever minute you land on, don't round

Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.

## Durability

By default (durable: false) the job lives only in this Pi session — nothing is written to disk, and the job is gone when Pi exits. Pass durable: true to write to .pi/scheduled_tasks.json so the job survives restarts. Only use durable: true when the user explicitly asks for the task to persist ("keep doing this every day", "set this up permanently"). Most "remind me in 5 minutes" / "check back in an hour" requests should stay session-only.

## Runtime behavior

Jobs only fire while the REPL is idle (not mid-query). Durable jobs persist to .pi/scheduled_tasks.json and survive session restarts — on next launch they resume automatically. One-shot durable tasks that were missed while the REPL was closed are surfaced for catch-up. Session-only jobs die with the process. The scheduler adds a small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early. Picking an off-minute is still the bigger lever.

Recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days — they fire one final time, then are deleted. This bounds session lifetime. Tell the user about the ${DEFAULT_MAX_AGE_DAYS}-day limit when scheduling recurring jobs.

Returns a job ID you can pass to ${TOOL_CRON_DELETE}.`;
}

function buildCronListPrompt(): string {
	return `List all cron jobs scheduled via ${TOOL_CRON_CREATE} for this project — durable jobs (loaded from \`<cwd>/.pi/scheduled_tasks.json\`) plus any session-only jobs added this session.`;
}

const CRON_DELETE_DESCRIPTION = "Cancel a cron job previously scheduled with CronCreate. Removes it from .pi/scheduled_tasks.json (durable jobs) or the in-memory session store (session-only jobs).";
const CRON_LIST_DESCRIPTION = "List all cron jobs scheduled via CronCreate, both durable (.pi/scheduled_tasks.json) and session-only.";

// ---------------------------------------------------------------------------
// §9 Fire-delivery helper
// ---------------------------------------------------------------------------

// `currentPi` is pinned to the ROOT session's api at session_start and only
// re-pinned when that binding dies (stale recovery below). It becomes stale
// after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload()
// — see agent-session.js dispose() → extensionRunner.invalidate(). The
// shared runtime's assertActive() then throws from every action, including
// sendMessage. Background setTimeout callbacks have no recovery path (the
// fresh ctx only exists inside withSession callbacks), so we detect the
// stale-ctx error per-call and attempt to rebind to the freshest live api.

function deliverFire(job: CronJob): boolean {
	if (!currentPi) {
		job.lastDeliveryResult = "no-pi";
		// debugLog(`deliverFire(${job.id}): no currentPi; recording no-pi`);
		return false;
	}
	// Wrap the scheduled prompt in a backtick fence one longer than the
	// longest run of backticks in the prompt body, to prevent the model from
	// re-interpreting the prompt as instructions/format. Matches Claude Code.
	const longestRun = job.prompt.match(/`+/g)?.reduce((m, s) => Math.max(m, s.length), 0) ?? 0;
	const fence = "`".repeat(longestRun + 1);
	const wrapped = `${fence}\n${job.prompt}\n${fence}`;
	const send = (api: ExtensionAPI): void => {
		api.sendMessage(
			{
				customType: "picc-loop-fire",
				content: wrapped,
				display: false,
				details: {
					jobId: job.id,
					recurring: job.recurring,
					cron: job.cron,
					nextRun: job.nextRun,
				},
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	};
	try {
		send(currentPi);
		job.lastDeliveryResult = "ok";
		// debugLog(`deliverFire(${job.id}): sendMessage ok (steer+triggerTurn)`);
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("This extension ctx is stale")) {
			// Stale context: the captured api's shared runtime was poisoned by a
			// session dispose (session replacement, or an in-process subagent
			// teardown via pi-subagents). Try to recover by rebinding to the most
			// recent session's api if it is still alive — this heals the common
			// case where a subagent session_start briefly took over the binding.
			if (lastSessionPi && lastSessionPi !== currentPi && probeAlive(lastSessionPi)) {
				// debugLog(`deliverFire(${job.id}): stale; attempting recovery via last session api`);
				currentPi = lastSessionPi;
				try {
					send(currentPi);
					job.lastDeliveryResult = "ok";
					// debugLog(`deliverFire(${job.id}): recovered via last session api; sendMessage ok`);
					return true;
				} catch (err2) {
					const msg2 = err2 instanceof Error ? err2.message : String(err2);
					job.lastDeliveryResult = "stale-ctx";
					// debugLog(`deliverFire(${job.id}): recovery failed: ${msg2}`);
				}
			}
			job.lastDeliveryResult = "stale-ctx";
			// debugLog(`deliverFire(${job.id}): ctx stale; recording stale-ctx`);
			return false;
		}
		// Any other error: onFire re-arms (lastFiredAt NOT advanced) so the
		// next cron match is computed from the same anchor and we retry.
		job.lastDeliveryResult = "error";
		// debugLog(`deliverFire(${job.id}): error: ${msg}`);
		return false;
	}
}

// ---------------------------------------------------------------------------
// §10 /loop slash command + meta-prompt
// Adapted verbatim from Claude Code's skills/bundled/loop.ts.
// ---------------------------------------------------------------------------

const USAGE_MESSAGE = `Usage: /loop [interval] <prompt>

Run a prompt or slash command on a recurring interval.

Intervals: Ns, Nm, Nh, Nd (e.g. 5m, 30m, 2h, 1d). Minimum granularity is 1 minute.
If no interval is specified, defaults to ${DEFAULT_LOOP_INTERVAL}.

Examples:
  /loop 5m /babysit-prs
  /loop 30m check the deploy
  /loop 1h /standup 1
  /loop check the deploy          (defaults to ${DEFAULT_LOOP_INTERVAL})
  /loop check the deploy every 20m`;

// Parse "/loop" args following rules 1-3 from claude-code.
function parseLoopArgs(args: string): { interval: string; prompt: string } | null {
	const trimmed = args.trim();
	if (!trimmed) return null;

	// Rule 1: leading token N<unit>
	const leadingMatch = trimmed.match(/^(\d+\s*[smhd])\b\s*(.*)$/i);
	if (leadingMatch) {
		const interval = leadingMatch[1]!.replace(/\s+/g, "").toLowerCase();
		const prompt = leadingMatch[2]!.trim();
		if (!prompt) return null;
		return { interval, prompt };
	}

	// Rule 2: trailing "every <N><unit>" or "every <N> <unit-word>"
	const everyShortMatch = trimmed.match(/\bevery\s+(\d+\s*[smhd])\b\s*$/i);
	if (everyShortMatch) {
		const interval = everyShortMatch[1]!.replace(/\s+/g, "").toLowerCase();
		const prompt = trimmed.slice(0, everyShortMatch.index).trim();
		if (!prompt) return null;
		return { interval, prompt };
	}
	const everyWordMatch = trimmed.match(/\bevery\s+(\d+)\s+(second|minute|hour|day)s?\s*$/i);
	if (everyWordMatch) {
		const n = everyWordMatch[1]!;
		const word = everyWordMatch[2]!.toLowerCase();
		const unitChar = word.startsWith("s") ? "s" : word[0];
		const interval = `${n}${unitChar}`.toLowerCase();
		const prompt = trimmed.slice(0, everyWordMatch.index).trim();
		if (!prompt) return null;
		return { interval, prompt };
	}

	// Rule 3: default interval
	return { interval: DEFAULT_LOOP_INTERVAL, prompt: trimmed };
}

// Convert "5m" / "2h" / "1d" / "90m" / "30s" to a 5-field cron expression.
// Mirrors the table in claude-code/skills/bundled/loop.ts.
function intervalToCron(interval: string): { cron: string; rounded?: string } | null {
	const m = interval.match(/^(\d+)([smhd])$/i);
	if (!m) return null;
	const n = parseInt(m[1]!, 10);
	const unit = m[2]!.toLowerCase();

	if (unit === "s") {
		const minutes = Math.max(1, Math.ceil(n / 60));
		if (n > 60) return { cron: `*/${minutes} * * * *`, rounded: `${minutes}m` };
		return { cron: `*/1 * * * *`, rounded: "1m" };
	}
	if (unit === "m") {
		if (n <= 59) {
			// pick nearest clean divisor if n doesn't divide 60
			if (n > 0 && 60 % n === 0) return { cron: `*/${n} * * * *` };
			const candidates = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
			const nearest = candidates.reduce((best, c) =>
				Math.abs(c - n) < Math.abs(best - n) ? c : best,
			);
			return { cron: `*/${nearest} * * * *`, rounded: `${nearest}m` };
		}
		// n >= 60: round to hours
		const hours = Math.round(n / 60);
		if (24 % hours === 0) return { cron: `0 */${hours} * * *`, rounded: `${hours}h` };
		const hourCandidates = [1, 2, 3, 4, 6, 8, 12];
		const nearestH = hourCandidates.reduce((best, h) =>
			Math.abs(h * 60 - n) < Math.abs(best * 60 - n) ? h : best,
		);
		return { cron: `0 */${nearestH} * * *`, rounded: `${nearestH}h` };
	}
	if (unit === "h") {
		if (n <= 0) return null;
		if (n <= 23 && 24 % n === 0) return { cron: `0 */${n} * * *` };
		const candidates = [1, 2, 3, 4, 6, 8, 12];
		const nearest = candidates.reduce((best, c) =>
			Math.abs(c - n) < Math.abs(best - n) ? c : best,
		);
		return { cron: `0 */${nearest} * * *`, rounded: `${nearest}h` };
	}
	if (unit === "d") {
		if (n <= 0) return null;
		return { cron: `0 0 */${n} * *` };
	}
	return null;
}

function buildLoopPrompt(args: string): string {
	const parsed = parseLoopArgs(args);
	if (!parsed) {
		return `# /loop — schedule a recurring prompt

Empty prompt. Show usage:

${USAGE_MESSAGE}`;
	}
	const converted = intervalToCron(parsed.interval);
	if (!converted) {
		return `# /loop — schedule a recurring prompt

Could not parse interval "${parsed.interval}". Supported suffixes: s, m, h, d (e.g. 5m, 2h, 1d).`;
	}
	const cronExpr = converted.cron;
	const humanExpr = cronToHuman(cronExpr);
	const roundedNote = converted.rounded
		? `

Note: the requested interval was rounded to ${converted.rounded} (cron minimum granularity is 1 minute; pick the nearest clean divisor).`
		: "";

	return `# /loop — schedule a recurring prompt

The user invoked \`/loop ${args}\`. You should schedule this with ${TOOL_CRON_CREATE}.

## Parsing result

- Interval: \`${parsed.interval}\` → cron \`${cronExpr}\` (${humanExpr})${roundedNote}
- Prompt: \`${parsed.prompt}\`

## Action

1. Call ${TOOL_CRON_CREATE} with:
   - \`cron\`: \`${cronExpr}\`
   - \`prompt\`: \`${parsed.prompt}\` verbatim (slash commands are passed through unchanged)
   - \`recurring\`: \`true\`
2. Briefly confirm: what's scheduled, the human-readable cadence (${humanExpr}), that recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days, and that they can cancel sooner with ${TOOL_CRON_DELETE} (include the job ID).
3. **Then immediately execute the parsed prompt now** — don't wait for the first cron fire. If it's a slash command, invoke it directly; otherwise act on it directly.

## Input

${args}`;
}

// ---------------------------------------------------------------------------
// §11 Session lifecycle + factory export
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Tool registrations — all happen at module load, which is fine per docs.
	// Background timers are kicked off only from CronCreate.execute (tool-call
	// context), never from this factory body.

	// ----- CronCreate -----
	pi.registerTool({
		name: TOOL_CRON_CREATE,
		label: "CronCreate",
		description: buildCronCreateDescription(),
		promptSnippet:
			"Schedule a prompt to be enqueued at a future time.",
		promptGuidelines: [],
		parameters: Type.Object({
			cron: Type.String({
				description:
					'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
			}),
            durable: Type.Optional(
                Type.Boolean({
                    default: false,
                    description:
                        "true = persist to .claude/scheduled_tasks.json and survive restarts. false (default) = in-memory only, dies when this Claude session ends. Use true only when the user asks the task to survive across sessions.",
                }),
            ),
			prompt: Type.String({
				description: "The prompt to enqueue at each fire time.",
			}),
			recurring: Type.Optional(
				Type.Boolean({
					default: true,
					description: `true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for \"remind me at X\" one-shot requests with pinned minute/hour/dom/month.`,
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const fields = parseCronExpression(params.cron);
			if (!fields) {
				throw new Error(
					`Invalid cron expression '${params.cron}'. Expected 5 fields: M H DoM Mon DoW.`,
				);
			}
			const next = computeNextCronRun(fields, new Date());
			if (next === null) {
				throw new Error(
					`Cron expression '${params.cron}' does not match any calendar date in the next year.`,
				);
			}
			if (jobs.size >= MAX_JOBS) {
				throw new Error(
					`Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`,
				);
			}

			const recurring = params.recurring ?? true;
			const durable = params.durable ?? true;
			const now = Date.now();

			const id = generateId();
			const job: CronJob = {
				id,
				cron: params.cron,
				prompt: params.prompt,
				recurring,
				durable,
				createdAt: now,
			};
			jobs.set(id, job);
			if (durable) persistJobs();
			// debugLog(`CronCreate: ${id} cron=${params.cron} recurring=${recurring} durable=${durable} isLeader=${isLeader}`);
			// Only the scheduler leader runs timers in-process. If we are a
			// passive peer, the job is on disk and the leader will pick it up
			// on its next 5s probe. For durable: false (session-only) jobs,
			// arm the timer in this session regardless — these never touch
			// disk and are intentionally scoped to the creating session.
			if (isLeader || !durable) scheduleTimer(job);

			const humanSchedule = cronToHuman(params.cron);
			const storageNote = durable
				? `Persisted to .pi/scheduled_tasks.json (auto-deletes when cancelled or, for recurring, after ${DEFAULT_MAX_AGE_DAYS} days).`
				: `Session-only (not written to disk; dies when this pi session ends).`;
			const text = job.recurring
				? `Scheduled recurring job ${id} (${humanSchedule}). ${storageNote} Use ${TOOL_CRON_DELETE} to cancel sooner.`
				: `Scheduled one-shot task ${id} (${humanSchedule}). ${storageNote} It will fire once then auto-delete.`;
			return {
				content: [{ type: "text", text }],
				details: { id, humanSchedule, recurring: job.recurring, durable: job.durable },
			};
		},
	});

	// ----- CronDelete -----
	pi.registerTool({
		name: TOOL_CRON_DELETE,
		label: "CronDelete",
		description: CRON_DELETE_DESCRIPTION,
		promptSnippet: "Cancel a cron job previously scheduled with CronCreate.",
		promptGuidelines: [],
		parameters: Type.Object({
			id: Type.String({ description: "Job ID returned by CronCreate." }),
		}),
		async execute(_toolCallId, params) {
			let job = jobs.get(params.id);

			// If not in memory, check disk for durable jobs. This handles the
			// case where session_shutdown cleared the map but durable jobs
			// still exist on disk.
			if (!job && stateFile) {
				const loaded = loadTasksFromDisk(stateFile);
				const diskJob = loaded.find((pt) => pt.id === params.id);
				if (diskJob) {
					// Found on disk -- remove from disk directly.
					const remaining = loaded.filter((pt) => pt.id !== params.id);
					try {
						atomicWriteJson(stateFile, { tasks: remaining });
					} catch (err) {
					}
					return {
						content: [{ type: "text", text: `Cancelled job ${params.id}.` }],
						details: { id: params.id },
					};
				}
			}

			if (!job) {
				throw new Error(`${TOOL_CRON_DELETE}: no job with id '${params.id}'.`);
			}
			const wasDurable = job.durable;
			if (job.timer) clearTimeout(job.timer);
			jobs.delete(params.id);
			if (wasDurable) persistJobs();
			return {
				content: [{ type: "text", text: `Cancelled job ${params.id}.` }],
				details: { id: params.id },
			};
		},
	});

	// ----- CronList -----
	pi.registerTool({
		name: TOOL_CRON_LIST,
		label: "CronList",
		description: CRON_LIST_DESCRIPTION,
		promptSnippet: "List all cron jobs scheduled via CronCreate.",
		promptGuidelines: [],
		parameters: Type.Object({}),
		async execute() {
			// If in-memory map is empty but we have a state file, check disk for
			// durable jobs. This handles the window between session_shutdown
			// (which clears the map) and the next session_start (which reloads).
			let jobList: CronJob[] = Array.from(jobs.values());
			if (jobList.length === 0 && stateFile) {
				const loaded = loadTasksFromDisk(stateFile);
				if (loaded.length > 0) {
					for (const pt of loaded) {
						// Skip one-shots that already fired.
						if (!pt.recurring && typeof pt.lastFiredAt === "number") continue;
						jobList.push({
							id: pt.id,
							cron: pt.cron,
							prompt: pt.prompt,
							recurring: pt.recurring ?? false,
							durable: true,
							createdAt: pt.createdAt,
							lastFiredAt: pt.lastFiredAt,
						});
					}
				}
			}

			if (jobList.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No scheduled cron jobs. Use CronCreate to set one up.",
						},
					],
					details: { jobs: [] },
				};
			}
			const list = jobList.map((j) => ({
				id: j.id,
				cron: j.cron,
				humanSchedule: cronToHuman(j.cron),
				prompt: j.prompt,
				recurring: j.recurring,
				durable: j.durable,
			}));
			const text = list
				.map(
					(j) =>
						`${j.id} — ${j.humanSchedule} (${j.recurring ? "recurring" : "one-shot"}) [${j.durable ? "durable" : "session-only"}]: ${j.prompt}`,
				)
				.join("\n");
			return {
				content: [{ type: "text", text }],
				details: { jobs: list },
			};
		},
	});

	// ----- /loop command -----
	pi.registerCommand("loop", {
		description: `Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to ${DEFAULT_LOOP_INTERVAL})`,
		argumentHint: "[interval] <prompt>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify(USAGE_MESSAGE, "info");
				return;
			}
			pi.sendMessage(
				{
					customType: "picc-loop-meta",
					content: buildLoopPrompt(trimmed),
					display: false,
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		},
	});

	// ----- Session lifecycle -----
	pi.on("session_start", () => {
		// Capture the ROOT session's api once per process. Subagent sessions
		// (pi-subagents runs them in-process with `extensions: true`, so this
		// module's handlers fire for them too) must never clobber the scheduler
		// binding: the shared extension runtime is permanently poisoned the
		// moment any such session is disposed (AgentSession.dispose() →
		// runtime.invalidate() sets staleMessage with ??=, never cleared). We
		// detect secondary sessions by API IDENTITY — the handler closure's
		// `pi` differs from the pinned `currentPi` — with zero reliance on env
		// vars (PI_SUBAGENT_CHILD leaks into main sessions and is not a
		// trustworthy detector).
		if (!rootPi) rootPi = pi;
		lastSessionPi = pi;

		const isBindingSession = currentPi === undefined || currentPi === pi;
		if (!isBindingSession) {
			// debugLog(`session_start: secondary session; scheduler state untouched (pi !== currentPi)`);
			return;
		}

		currentPi = rootPi;
		agentBusyCount = 0;
		agentBusySince = null;
		clearAllTimers();
		jobs.clear();

		// Resolve state file from cwd. Lifecycle events don't carry ctx; use
		// process.cwd() which matches what ctx.cwd will be during the session.
		const cwd = process.cwd();
		stateFile = `${cwd}/.pi/scheduled_tasks.json`;

		// Open per-session debug log. Overwritten at the start of each session
		// so a stale log from a previous run is easy to tell apart.
		// debugLogPath = `${cwd}/.pi/picc-loop-debug.log`;
		// try {
		// 	writeFileSync(debugLogPath, `--- picc-loop debug log ---\n`, "utf8");
		// } catch {
		// 	/* best-effort */
		// }
		// debugLog(`session_start: cwd=${cwd} pid=${process.pid} (binding session)`);

		// Scheduler ownership is decided purely by the cross-session lock.
		// The PI_SUBAGENT_CHILD env var is unreliable as a subagent detector
		// (it leaks into "main" sessions via shell env, crashed pi-subagents
		// invocations, etc.), so lock-based election is the single source of
		// truth. If another session holds the lock for this cwd, this session
		// stays passive; otherwise it becomes the scheduler.
		lockPath = `${cwd}/.pi/scheduled_tasks.lock`;
		isLeader = acquireLockOrStealStale(lockPath);
		// debugLog(
		// 	`session_start: PI_SUBAGENT_CHILD=${process.env.PI_SUBAGENT_CHILD ?? "<unset>"} (ignored, lock-based election); lockPath=${lockPath} isLeader=${isLeader}`,
		// );
		// debugLog(`session_start: lockPath=${lockPath} isLeader=${isLeader}`);
		if (isLeader) {
			loadJobsFromDiskAndSchedule();
			// debugLog(`session_start: became leader, armed ${jobs.size} job(s); next fire in ${formatMsUntilNextFire()}ms`);
		} else {
			// debugLog(`session_start: passive peer, ${lockPath} held by another session`);
		}
		// Every main session runs the probe so that any of them can take
		// over if the current leader exits.
		startProbeLoop();
		// Always start the tick loop — the leader uses it to fire jobs; passive
		// peers keep it idle but it's cheap (1s interval, exits fast on empty
		// jobs map). Crucially, the tick loop runs whether or not we are
		// leader, so if a passive peer steals the lock via probe, the tick
		// loop is already running and will start dispatching immediately.
		startTickLoop();
	});
	pi.on("agent_start", () => {
		agentBusyCount++;
		if (agentBusySince === null) agentBusySince = Date.now();
	});
	pi.on("agent_settled", () => {
		if (agentBusyCount > 0) {
			agentBusyCount--;
			if (agentBusyCount === 0) agentBusySince = null;
		}
	});
	pi.on("session_shutdown", () => {
		// Only the binding session's shutdown owns the scheduler state. A
		// subagent teardown (session.dispose() → shared-runtime poison) must
		// not release the main session's lock or clear its jobs.
		if (currentPi !== pi) {
			// debugLog(`session_shutdown: non-binding session; leaving scheduler state intact`);
			return;
		}
		// Durable jobs survive shutdown via the .pi/scheduled_tasks.json file.
		// In-memory (durable: false) jobs are intentionally discarded.
		// Release the cross-session lock so the next running pi process can
		// take over within 5s. If the session is still alive when the next
		// probe fires, releaseLock() already nulled lockPath; passive peers
		// then see a stale-or-missing lock and steal it.
		// debugLog(`session_shutdown: stopping probe, tick, clearing ${jobs.size} job(s), releasing lock`);
		stopProbeLoop();
		stopTickLoop();
		clearAllTimers();
		jobs.clear();
		releaseLock();
		// Forget the root binding so a subsequent session_start (e.g. /new,
		// /resume, /fork) rebinds a fresh api instead of a poisoned one.
		currentPi = undefined;
		rootPi = undefined;
		stateFile = null;
		lockPath = null;
		isLeader = false;
	});
}
