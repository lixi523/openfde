import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { Ledger } from "../ledger/database.js";
import { nowIso } from "../ledger/database.js";
import { ensureDir, openfdeHome, runsDir } from "../engagement/paths.js";
import { buildTaskContext, contextMarkdown } from "./context.js";
import { getTask, listTasks, transitionTask, addTaskNote, type TaskRow } from "./tasks.js";
import { createRun, getRun, listRuns, updateRun, type RunRow } from "./runs.js";
import { ensureWorktree, worktreeStatus, type WorktreeStatus } from "./worktree.js";
import { buildFdeDoc, fdeMarkdown, fdeProtocolMarkdown } from "../projections/fde.js";
import type { AgentEvent, Executor, PermissionLevel } from "./executors.js";

/**
 * The orchestrated runner (DESIGN 4.6, Mode A). It sits on the same task table
 * as agent-pull dispatch: a run claims a ready task, opens the task's worktree,
 * hands the agent the cited context pack plus an operating protocol, streams
 * the agent's events into a log, and moves the task on when the agent stops.
 *
 * Exit is multi-valued on purpose (the Ralph lesson: one "DONE" string is not
 * enough). The agent ends its final message with one of three markers:
 *   DONE: <summary>          → task goes to review
 *   BLOCKED: <reason>        → task returns to ready, unclaimed, reason on the trail
 *   NEEDS_HUMAN: <question>  → task stays running; a human answers with a follow-up
 * A process that dies without a marker is a failed run; the task returns to ready.
 */

export type ExitMarker = "DONE" | "BLOCKED" | "NEEDS_HUMAN";

export interface RunOptions {
  executor: Executor;
  /** Repository the task is about; the worktree is forked from it */
  repo: string;
  /** Branch to fork the task branch from; defaults to the repo's checked-out branch */
  base?: string;
  /** Skip worktree isolation and run directly in the repo (small repos, demos) */
  noWorktree?: boolean;
  permission?: PermissionLevel;
  maxTurns?: number;
  model?: string;
  /** Kill the agent after this many milliseconds without any event */
  stallMs?: number;
  /** Hard cap on a run's wall-clock time */
  timeoutMs?: number;
  actor?: string;
  onEvent?: (event: AgentEvent, run: RunRow) => void;
}

export interface RunOutcome {
  run: RunRow;
  task: TaskRow;
  worktree: WorktreeStatus | null;
}

const MARKER_RE = /^\s*(DONE|BLOCKED|NEEDS_HUMAN)\s*:\s*(.*)$/im;

/** Find the agent's exit declaration in its last message(s) */
export function parseExitMarker(text: string | undefined): { marker: ExitMarker; detail: string } | null {
  if (!text) return null;
  // the marker is expected on its own line, usually the last one; scan from the end
  const lines = text.split("\n").reverse();
  for (const line of lines) {
    const m = line.match(MARKER_RE);
    if (m) return { marker: m[1]!.toUpperCase() as ExitMarker, detail: m[2]!.trim() };
  }
  return null;
}

export interface PromptInput {
  engagement: string;
  runId: string;
  branch: string | null;
  cwd: string;
  executorName: string;
  contextMarkdown: string;
  /** The engagement's FDE.md; defaults to the bare protocol when no ledger is at hand */
  brief?: string;
}

/**
 * The dispatch prompt: where you are + FDE.md (who we serve, constraints,
 * memory and work protocol, exit markers) + the task's cited context pack.
 * The protocol text lives in FDE.md so both dispatch modes read one rulebook.
 */
export function buildRunPrompt(input: PromptInput): string {
  const where = input.branch
    ? `You are working in an isolated git worktree at \`${input.cwd}\` on branch \`${input.branch}\`. Commit your work on this branch as you go; do not switch branches, do not push.`
    : `You are working directly in the repository at \`${input.cwd}\`. Commit your work as you go; do not push.`;
  return [
    `You are a coding agent dispatched by OpenFDE (engagement \`${input.engagement}\`, run \`${input.runId}\`) to carry out one task for a customer engagement. The \`openfde\` CLI is on your PATH and already points at this engagement.`,
    "",
    where,
    "",
    "Read the deployment brief (FDE.md) and the task context below before touching anything. **Constraints outrank the task wording.** Finish with exactly one exit-marker line as the brief describes.",
    "",
    "---",
    "",
    input.brief ?? fdeProtocolMarkdown(),
    "",
    "---",
    "",
    input.contextMarkdown,
  ].join("\n");
}

/**
 * Spawned agents must be able to call `openfde`. When the binary is not on
 * PATH (a dev checkout driven through `pnpm openfde`, or an unlinked build),
 * write a shim that re-invokes exactly the CLI entry point running now —
 * same node, same loader flags, same script — and prepend its directory.
 */
export function ensureCliOnPath(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const path = env.PATH ?? "";
  const onPath = path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => existsSync(join(dir, "openfde")));
  if (onPath) return env;
  const entry = process.argv[1];
  if (!entry) return env;
  const shimDir = ensureDir(join(home, "bin"));
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const shim = [
    "#!/bin/sh",
    "# generated by openfde run: makes the CLI that started this run available to the agent",
    `exec ${quote(process.execPath)} ${process.execArgv.map(quote).join(" ")} ${quote(entry)} "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(shimDir, "openfde"), shim, { mode: 0o755 });
  return { ...env, PATH: `${shimDir}${delimiter}${path}` };
}

function appendLog(path: string, event: AgentEvent): void {
  appendFileSync(path, JSON.stringify({ at: nowIso(), ...event }) + "\n");
}

function shortstatNote(status: WorktreeStatus | null): string {
  if (!status) return "";
  const parts = [`${status.ahead} commit(s) on ${status.branch}`];
  if (status.shortstat) parts.push(status.shortstat);
  if (status.dirty > 0) parts.push(`${status.dirty} uncommitted file(s)`);
  return parts.join(" · ");
}

/**
 * Run one task with an agent. The task must be `ready` (it gets claimed) or
 * already claimed by anyone. Returns when the agent process has exited and the
 * task has been moved on.
 */
export async function runTask(
  db: Ledger,
  engagement: string,
  taskId: string,
  options: RunOptions,
): Promise<RunOutcome> {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`task "${taskId}" not found`);
  if (task.status !== "ready" && task.status !== "claimed") {
    throw new Error(`task ${taskId} is ${task.status}; only ready or claimed tasks can be run`);
  }
  const actor = options.actor ?? options.executor.name;
  if (task.status === "ready") transitionTask(db, taskId, "claimed", { actor });

  const repo = resolve(options.repo);
  let cwd = repo;
  let branch: string | null = null;
  let base: string | null = null;
  if (!options.noWorktree) {
    const wt = ensureWorktree({ repo, engagement, taskId, base: options.base });
    cwd = wt.path;
    branch = wt.branch;
    base = wt.base;
  }

  const logPath = join(ensureDir(runsDir(engagement)), `${taskId}-${Date.now()}.jsonl`);
  const run = createRun(db, {
    taskId,
    executor: options.executor.name,
    repo,
    worktree: branch ? cwd : undefined,
    branch: branch ?? undefined,
    logPath,
  });

  const context = buildTaskContext(db, taskId);
  const prompt = buildRunPrompt({
    engagement,
    runId: run.id,
    branch,
    cwd,
    executorName: options.executor.name,
    contextMarkdown: contextMarkdown(context),
    brief: fdeMarkdown(buildFdeDoc(db, engagement)),
  });

  transitionTask(db, taskId, "running", {
    actor,
    note: `run ${run.id} started (${options.executor.name}${branch ? ` on ${branch}` : ""})`,
  });

  return drive(db, engagement, run, task.id, prompt, { ...options, actor }, { cwd, base });
}

/**
 * Continue a finished run's session with a new message — review feedback, the
 * answer to a NEEDS_HUMAN question, or a nudge after BLOCKED. Same worktree,
 * same branch, same agent session; a new run row records the exchange.
 */
export async function followUpRun(
  db: Ledger,
  engagement: string,
  runId: string,
  message: string,
  options: Omit<RunOptions, "repo"> & { repo?: string },
): Promise<RunOutcome> {
  const parent = getRun(db, runId);
  if (!parent) throw new Error(`run "${runId}" not found`);
  if (parent.status === "starting" || parent.status === "running") {
    throw new Error(`run ${runId} is still ${parent.status}`);
  }
  if (!parent.session_id) {
    throw new Error(`run ${runId} recorded no session id; start a fresh run with \`openfde run ${parent.task_id}\``);
  }
  if (!message.trim()) throw new Error("a follow-up needs a message");
  const task = getTask(db, parent.task_id);
  if (!task) throw new Error(`task "${parent.task_id}" not found`);
  const actor = options.actor ?? options.executor.name;

  // bring the task back to running along legal transitions
  if (task.status === "rejected") transitionTask(db, task.id, "ready", { actor, note: "rework requested" });
  const current = getTask(db, task.id)!.status;
  if (current === "ready") transitionTask(db, task.id, "claimed", { actor });
  if (getTask(db, task.id)!.status === "claimed") transitionTask(db, task.id, "running", { actor });
  else if (current === "review") transitionTask(db, task.id, "running", { actor, note: "rework" });
  else if (current !== "running") {
    throw new Error(`task ${task.id} is ${current}; cannot follow up`);
  }

  const cwd = parent.worktree ?? parent.repo;
  if (!existsSync(cwd)) throw new Error(`worktree ${cwd} no longer exists; start a fresh run`);
  const run = createRun(db, {
    taskId: task.id,
    parentRunId: parent.id,
    executor: options.executor.name,
    repo: parent.repo,
    worktree: parent.worktree ?? undefined,
    branch: parent.branch ?? undefined,
    logPath: join(ensureDir(runsDir(engagement)), `${task.id}-${Date.now()}.jsonl`),
  });
  addTaskNote(db, task.id, `follow-up ${run.id} → ${parent.id}: ${message.trim()}`, actor);

  const prompt = [
    `Follow-up from the FDE on task ${task.id} (run ${run.id}, continuing session ${parent.session_id}):`,
    "",
    message.trim(),
    "",
    "Same rules as before: commit on the task branch, use `openfde` for memory, and end your final message with one line — `DONE: …`, `BLOCKED: …`, or `NEEDS_HUMAN: …`.",
  ].join("\n");

  return drive(
    db,
    engagement,
    run,
    task.id,
    prompt,
    { ...options, repo: parent.repo, actor },
    { cwd, base: options.base ?? null, resumeSessionId: parent.session_id },
  );
}

interface DriveContext {
  cwd: string;
  base: string | null;
  resumeSessionId?: string;
}

async function drive(
  db: Ledger,
  engagement: string,
  run: RunRow,
  taskId: string,
  prompt: string,
  options: RunOptions & { actor: string },
  ctx: DriveContext,
): Promise<RunOutcome> {
  const env = ensureCliOnPath(
    {
      ...process.env,
      OPENFDE_ENGAGEMENT: engagement,
      OPENFDE_ACTOR: options.executor.name,
      OPENFDE_TASK_ID: taskId,
      OPENFDE_RUN_ID: run.id,
    },
    openfdeHome(),
  );
  const proc = options.executor.spawn({
    cwd: ctx.cwd,
    prompt,
    permission: options.permission ?? "edit",
    maxTurns: options.maxTurns,
    model: options.model,
    resumeSessionId: ctx.resumeSessionId,
    env,
  });
  updateRun(db, run.id, { status: "running", pid: proc.pid });

  let sessionId: string | undefined = ctx.resumeSessionId;
  let lastMessage: string | undefined;
  let result: Extract<AgentEvent, { kind: "result" }> | undefined;
  let toolCalls = 0;
  let killed: "stall" | "timeout" | null = null;

  const startedAt = Date.now();
  let stallTimer: NodeJS.Timeout | undefined;
  const armStall = () => {
    if (!options.stallMs) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      killed = "stall";
      proc.kill();
    }, options.stallMs);
    stallTimer.unref?.();
  };
  const timeoutTimer = options.timeoutMs
    ? setTimeout(() => {
        killed = "timeout";
        proc.kill();
      }, options.timeoutMs)
    : undefined;
  timeoutTimer?.unref?.();
  armStall();

  for await (const event of proc.events) {
    appendLog(run.log_path, event);
    armStall();
    switch (event.kind) {
      case "session":
        sessionId = event.sessionId;
        updateRun(db, run.id, { session_id: sessionId, heartbeat_at: nowIso() });
        break;
      case "message":
        lastMessage = event.text;
        updateRun(db, run.id, { heartbeat_at: nowIso() });
        break;
      case "tool":
        toolCalls += 1;
        updateRun(db, run.id, { tool_calls: toolCalls, heartbeat_at: nowIso() });
        break;
      case "result":
        result = event;
        if (event.sessionId) sessionId = event.sessionId;
        if (event.text) lastMessage = event.text;
        break;
      default:
        break;
    }
    options.onEvent?.(event, run);
  }
  const exitCode = await proc.exit;
  if (stallTimer) clearTimeout(stallTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);

  const wt = ctx.base && run.worktree ? worktreeStatus(run.worktree, ctx.base) : null;
  const marker = parseExitMarker(lastMessage);
  const ok = result?.ok === true && exitCode === 0 && killed === null;
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const costNote = result?.costUsd !== undefined ? ` · $${result.costUsd.toFixed(2)}` : "";
  const workNote = shortstatNote(wt);

  let status: RunRow["status"];
  let summary: string;
  if (killed) {
    status = "killed";
    summary = `killed after ${elapsed}s (${killed}); last message: ${(lastMessage ?? "").slice(0, 300)}`;
  } else if (!ok) {
    status = "failed";
    summary = result?.text ?? `agent exited with code ${exitCode}${lastMessage ? `; last message: ${lastMessage.slice(0, 300)}` : ""}`;
  } else if (marker?.marker === "BLOCKED") {
    status = "blocked";
    summary = marker.detail;
  } else if (marker?.marker === "NEEDS_HUMAN") {
    status = "needs_human";
    summary = marker.detail;
  } else {
    status = "done";
    summary = marker?.detail ?? (lastMessage ?? "").slice(0, 1000);
  }

  const finished = updateRun(db, run.id, {
    status,
    session_id: sessionId ?? null,
    exit_marker: marker?.marker ?? null,
    summary,
    cost_usd: result?.costUsd ?? null,
    turns: result?.turns ?? null,
    tool_calls: toolCalls,
    exit_code: exitCode,
    ended_at: nowIso(),
    pid: null,
  });

  // Move the task on — unless the agent already did it through the CLI.
  const actor = options.actor;
  const task = getTask(db, taskId)!;
  const tail = [workNote, `${elapsed}s${costNote}`].filter(Boolean).join(" · ");
  if (task.status === "running") {
    switch (status) {
      case "done":
        transitionTask(db, taskId, "review", { actor, note: `run ${run.id} DONE: ${summary}${tail ? ` (${tail})` : ""}` });
        break;
      case "blocked":
        transitionTask(db, taskId, "ready", { actor, note: `run ${run.id} BLOCKED: ${summary}${tail ? ` (${tail})` : ""}` });
        break;
      case "needs_human":
        addTaskNote(
          db,
          taskId,
          `run ${run.id} NEEDS_HUMAN: ${summary} — answer with \`openfde run followup ${run.id} "<answer>"\``,
          actor,
        );
        break;
      case "failed":
      case "killed":
        transitionTask(db, taskId, "ready", { actor, note: `run ${run.id} ${status}: ${summary.slice(0, 300)}${tail ? ` (${tail})` : ""}` });
        break;
      default:
        break;
    }
  } else {
    addTaskNote(db, taskId, `run ${run.id} ended ${status} (task already ${task.status}): ${summary.slice(0, 300)}`, actor);
  }

  return { run: finished, task: getTask(db, taskId)!, worktree: wt };
}

export interface RunReadyOptions extends RunOptions {
  /** Upper bound on concurrently running agents, counting runs already active */
  max?: number;
}

/**
 * Fan out over ready tasks (oldest first), respecting a concurrency cap that
 * counts runs already active in the ledger.
 */
export async function runReadyTasks(
  db: Ledger,
  engagement: string,
  options: RunReadyOptions,
): Promise<RunOutcome[]> {
  const max = options.max ?? 1;
  const active = listRuns(db, { active: true }).length;
  const slots = Math.max(0, max - active);
  const ready = listTasks(db, { status: "ready" }).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, slots);
  return Promise.all(ready.map((t) => runTask(db, engagement, t.id, options)));
}
