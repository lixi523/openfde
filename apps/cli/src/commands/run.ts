import type { Command } from "commander";
import {
  executorByName,
  followUpRun,
  getRun,
  listRuns,
  openLedger,
  resolveEngagement,
  runReadyTasks,
  runTask,
  type AgentEvent,
  type PermissionLevel,
  type RunOutcome,
  type RunRow,
} from "@openfde/core";
import { actorName, fail, withLedger } from "../lib/helpers.js";

interface RunFlags {
  engagement?: string;
  repo?: string;
  agent: string;
  base?: string;
  noWorktree?: boolean;
  permission: string;
  maxTurns?: string;
  model?: string;
  stall: string;
  timeout: string;
  ready?: boolean;
  max: string;
  quiet?: boolean;
  json?: boolean;
}

function parseDuration(text: string): number | undefined {
  const m = text.trim().match(/^(\d+)\s*(s|m|h)?$/i);
  if (!m) throw new Error(`bad duration "${text}" (use e.g. 90s, 20m, 2h)`);
  const n = Number(m[1]);
  if (n === 0) return undefined;
  const unit = (m[2] ?? "m").toLowerCase();
  return n * (unit === "s" ? 1000 : unit === "h" ? 3_600_000 : 60_000);
}

function permissionLevel(text: string): PermissionLevel {
  if (text === "plan" || text === "edit" || text === "bypass") return text;
  throw new Error(`bad --permission "${text}" (plan | edit | bypass)`);
}

/** Human-readable line per event, so the FDE can watch the agent work */
function printEvent(event: AgentEvent, run: RunRow): void {
  const tag = `[${run.id.slice(4, 10)}]`;
  switch (event.kind) {
    case "session":
      console.error(`${tag} session ${event.sessionId}`);
      break;
    case "message":
      console.error(`${tag} ${event.text.replace(/\s+/g, " ").slice(0, 200)}`);
      break;
    case "tool":
      console.error(`${tag}   ⚙ ${event.name} ${event.input}`.slice(0, 220));
      break;
    case "error":
      console.error(`${tag}   ✗ ${event.text}`);
      break;
    case "result":
      console.error(
        `${tag} ${event.ok ? "finished" : "failed"}${event.turns ? ` · ${event.turns} turns` : ""}${event.costUsd !== undefined ? ` · $${event.costUsd.toFixed(2)}` : ""}`,
      );
      break;
    default:
      break;
  }
}

function outcomeLine(o: RunOutcome): string {
  const wt = o.worktree ? ` · ${o.worktree.ahead} commit(s) on ${o.worktree.branch}${o.worktree.dirty ? `, ${o.worktree.dirty} uncommitted` : ""}` : "";
  return `${o.run.id} ${o.run.status.toUpperCase()} → task ${o.task.id} is ${o.task.status}${wt}\n  ${o.run.summary ?? ""}`;
}

export function registerRun(program: Command): void {
  const run = program
    .command("run")
    .description(
      "Orchestrated dispatch: spawn a coding agent (claude | codex) on a task in its own git worktree, stream its work into the audit trail, and move the task on from its exit marker",
    );

  run
    .command("task <taskId>", { isDefault: true })
    .alias("start")
    .description("Run one ready/claimed task with an agent")
    .option("-e, --engagement <slug>", "target engagement (defaults to current)")
    .requiredOption("-r, --repo <path>", "repository the task is about (the worktree forks from it)")
    .option("-a, --agent <name>", "claude | codex", "claude")
    .option("--base <branch>", "branch to fork the task branch from (default: the repo's current branch)")
    .option("--no-worktree", "work directly in the repo instead of an isolated worktree")
    .option("--permission <level>", "plan | edit | bypass", "edit")
    .option("--max-turns <n>", "cap agent turns (claude)")
    .option("--model <model>", "model override for the agent")
    .option("--stall <duration>", "kill the agent after this long without any event (0 = off)", "10m")
    .option("--timeout <duration>", "hard wall-clock cap for the run (0 = off)", "2h")
    .option("-q, --quiet", "do not stream agent events to stderr")
    .option("--json", "JSON output")
    .action(async (taskId: string, options: RunFlags) => {
      try {
        const slug = resolveEngagement(options.engagement);
        const db = openLedger(slug);
        try {
          const outcome = await runTask(db, slug, taskId, {
            executor: executorByName(options.agent),
            repo: options.repo!,
            base: options.base,
            noWorktree: options.noWorktree,
            permission: permissionLevel(options.permission),
            maxTurns: options.maxTurns ? Number(options.maxTurns) : undefined,
            model: options.model,
            stallMs: parseDuration(options.stall),
            timeoutMs: parseDuration(options.timeout),
            actor: actorName(),
            onEvent: options.quiet || options.json ? undefined : printEvent,
          });
          if (options.json) console.log(JSON.stringify(outcome));
          else console.log(outcomeLine(outcome));
        } finally {
          db.close();
        }
      } catch (error) {
        fail(error);
      }
    });

  run
    .command("ready")
    .description("Fan out: run every ready task, up to --max agents at once")
    .option("-e, --engagement <slug>", "target engagement (defaults to current)")
    .requiredOption("-r, --repo <path>", "repository the tasks are about")
    .option("-a, --agent <name>", "claude | codex", "claude")
    .option("--base <branch>", "branch to fork task branches from")
    .option("--max <n>", "max concurrent agents (counts runs already active)", "2")
    .option("--permission <level>", "plan | edit | bypass", "edit")
    .option("--max-turns <n>", "cap agent turns (claude)")
    .option("--model <model>", "model override for the agent")
    .option("--stall <duration>", "kill an agent after this long without any event (0 = off)", "10m")
    .option("--timeout <duration>", "hard wall-clock cap per run (0 = off)", "2h")
    .option("-q, --quiet", "do not stream agent events to stderr")
    .option("--json", "JSON output")
    .action(async (options: RunFlags) => {
      try {
        const slug = resolveEngagement(options.engagement);
        const db = openLedger(slug);
        try {
          const outcomes = await runReadyTasks(db, slug, {
            executor: executorByName(options.agent),
            repo: options.repo!,
            base: options.base,
            max: Number(options.max),
            permission: permissionLevel(options.permission),
            maxTurns: options.maxTurns ? Number(options.maxTurns) : undefined,
            model: options.model,
            stallMs: parseDuration(options.stall),
            timeoutMs: parseDuration(options.timeout),
            actor: actorName(),
            onEvent: options.quiet || options.json ? undefined : printEvent,
          });
          if (options.json) console.log(JSON.stringify({ engagement: slug, runs: outcomes }));
          else if (outcomes.length === 0) console.log("No ready tasks (or no free slots).");
          else console.log(outcomes.map(outcomeLine).join("\n"));
        } finally {
          db.close();
        }
      } catch (error) {
        fail(error);
      }
    });

  run
    .command("followup <runId> <message...>")
    .description("Continue a finished run's agent session: review feedback, the answer to NEEDS_HUMAN, or a nudge after BLOCKED")
    .option("-e, --engagement <slug>", "target engagement (defaults to current)")
    .option("-a, --agent <name>", "claude | codex (default: the original run's agent)")
    .option("--permission <level>", "plan | edit | bypass", "edit")
    .option("--max-turns <n>", "cap agent turns (claude)")
    .option("--model <model>", "model override for the agent")
    .option("--stall <duration>", "kill the agent after this long without any event (0 = off)", "10m")
    .option("--timeout <duration>", "hard wall-clock cap (0 = off)", "2h")
    .option("-q, --quiet", "do not stream agent events to stderr")
    .option("--json", "JSON output")
    .action(async (runId: string, words: string[], options: RunFlags) => {
      try {
        const slug = resolveEngagement(options.engagement);
        const db = openLedger(slug);
        try {
          const parent = getRun(db, runId);
          if (!parent) throw new Error(`run "${runId}" not found`);
          const outcome = await followUpRun(db, slug, runId, words.join(" "), {
            executor: executorByName(options.agent ?? parent.executor),
            permission: permissionLevel(options.permission),
            maxTurns: options.maxTurns ? Number(options.maxTurns) : undefined,
            model: options.model,
            stallMs: parseDuration(options.stall),
            timeoutMs: parseDuration(options.timeout),
            actor: actorName(),
            onEvent: options.quiet || options.json ? undefined : printEvent,
          });
          if (options.json) console.log(JSON.stringify(outcome));
          else console.log(outcomeLine(outcome));
        } finally {
          db.close();
        }
      } catch (error) {
        fail(error);
      }
    });

  run
    .command("list")
    .description("Runs recorded in this engagement (newest first)")
    .option("-e, --engagement <slug>", "target engagement (defaults to current)")
    .option("-t, --task <taskId>", "only runs of this task")
    .option("--active", "only starting/running runs")
    .option("--json", "JSON output")
    .action((options: { engagement?: string; task?: string; active?: boolean; json?: boolean }) => {
      try {
        const runs = withLedger(options.engagement, (db) => listRuns(db, { taskId: options.task, active: options.active }));
        if (options.json) console.log(JSON.stringify({ runs }));
        else if (runs.length === 0) console.log("No runs yet. Start one with `openfde run <taskId> --repo <path>`.");
        else
          for (const r of runs) {
            console.log(
              `${r.id}  ${r.status.padEnd(11)} ${r.executor.padEnd(11)} task ${r.task_id}${r.branch ? `  ${r.branch}` : ""}  ${r.started_at.slice(0, 16).replace("T", " ")}${r.summary ? `\n    ${(r.exit_marker ? `${r.exit_marker}: ` : "") + r.summary.replace(/\n/g, " ").slice(0, 160)}` : ""}`,
            );
          }
      } catch (error) {
        fail(error);
      }
    });

  run
    .command("show <runId>")
    .description("One run: metadata plus its normalized event log")
    .option("-e, --engagement <slug>", "target engagement (defaults to current)")
    .option("--json", "JSON output")
    .action(async (runId: string, options: { engagement?: string; json?: boolean }) => {
      try {
        const row = withLedger(options.engagement, (db) => getRun(db, runId));
        if (!row) throw new Error(`run "${runId}" not found`);
        const { readFileSync, existsSync } = await import("node:fs");
        const log = existsSync(row.log_path) ? readFileSync(row.log_path, "utf8").trim() : "";
        if (options.json) {
          console.log(JSON.stringify({ run: row, events: log ? log.split("\n").map((l) => JSON.parse(l)) : [] }));
          return;
        }
        console.log(`${row.id} ${row.status} · ${row.executor} · task ${row.task_id}`);
        if (row.branch) console.log(`worktree ${row.worktree} (${row.branch})`);
        if (row.session_id) console.log(`session ${row.session_id}`);
        console.log(`${row.started_at}${row.ended_at ? ` → ${row.ended_at}` : ""} · ${row.tool_calls} tool calls${row.cost_usd !== null ? ` · $${row.cost_usd.toFixed(2)}` : ""}`);
        if (row.summary) console.log(`\n${row.exit_marker ? `${row.exit_marker}: ` : ""}${row.summary}\n`);
        if (log) {
          console.log("--- events ---");
          for (const line of log.split("\n")) {
            const ev = JSON.parse(line) as { at: string; kind: string; text?: string; name?: string; input?: string; ok?: boolean };
            const body = ev.kind === "tool" ? `${ev.name} ${ev.input ?? ""}` : ev.kind === "tool_result" ? (ev.ok ? "ok" : "error") : (ev.text ?? "");
            console.log(`${ev.at.slice(11, 19)} ${ev.kind.padEnd(11)} ${body.replace(/\s+/g, " ").slice(0, 200)}`);
          }
        }
      } catch (error) {
        fail(error);
      }
    });
}
