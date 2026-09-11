import type { Ledger } from "../ledger/database.js";
import { newId, nowIso } from "../ledger/database.js";

/**
 * Run records: one row per agent process the runner spawned for a task.
 * Tasks own state; runs own the how — executor, worktree, branch, session id
 * (for follow-ups), cost, exit marker, and where the event log lives.
 */

export const RUN_STATUSES = [
  "starting",
  "running",
  "done",
  "blocked",
  "needs_human",
  "failed",
  "killed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunRow {
  id: string;
  task_id: string;
  parent_run_id: string | null;
  executor: string;
  repo: string;
  worktree: string | null;
  branch: string | null;
  session_id: string | null;
  status: RunStatus;
  /** DONE | BLOCKED | NEEDS_HUMAN, as declared by the agent's final message */
  exit_marker: string | null;
  summary: string | null;
  cost_usd: number | null;
  turns: number | null;
  tool_calls: number;
  exit_code: number | null;
  log_path: string;
  pid: number | null;
  started_at: string;
  heartbeat_at: string | null;
  ended_at: string | null;
}

export interface CreateRunInput {
  taskId: string;
  parentRunId?: string;
  executor: string;
  repo: string;
  worktree?: string;
  branch?: string;
  logPath: string;
}

export function createRun(db: Ledger, input: CreateRunInput): RunRow {
  const now = nowIso();
  const id = newId("run");
  db.prepare(
    `INSERT INTO runs (id, task_id, parent_run_id, executor, repo, worktree, branch, status, log_path, started_at, heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.parentRunId ?? null,
    input.executor,
    input.repo,
    input.worktree ?? null,
    input.branch ?? null,
    input.logPath,
    now,
    now,
  );
  return getRun(db, id)!;
}

export function getRun(db: Ledger, id: string): RunRow | null {
  return (db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined) ?? null;
}

export function listRuns(db: Ledger, options: { taskId?: string; active?: boolean } = {}): RunRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.taskId) {
    where.push("task_id = ?");
    params.push(options.taskId);
  }
  if (options.active) where.push("status IN ('starting','running')");
  const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC`;
  return db.prepare(sql).all(...params) as RunRow[];
}

export type RunPatch = Partial<
  Pick<
    RunRow,
    | "status"
    | "session_id"
    | "exit_marker"
    | "summary"
    | "cost_usd"
    | "turns"
    | "tool_calls"
    | "exit_code"
    | "pid"
    | "ended_at"
    | "heartbeat_at"
  >
>;

export function updateRun(db: Ledger, id: string, patch: RunPatch): RunRow {
  const keys = Object.keys(patch) as (keyof RunPatch)[];
  if (keys.length === 0) return getRun(db, id)!;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE runs SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), id);
  return getRun(db, id)!;
}

/** Latest run of a task, if any */
export function latestRun(db: Ledger, taskId: string): RunRow | null {
  return (
    (db
      .prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`)
      .get(taskId) as RunRow | undefined) ?? null
  );
}
