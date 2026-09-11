import type { Command } from "commander";
import { resolve } from "node:path";
import {
  currentBranch,
  ensureWorktree,
  listRuns,
  listWorktrees,
  removeWorktree,
  worktreeStatus,
} from "@openfde/core";
import { fail, withLedger } from "../lib/helpers.js";

export function registerWorktree(program: Command): void {
  const wt = program
    .command("worktree")
    .description("Task worktrees the runner created in a repository: list, open, remove");

  wt
    .command("list")
    .description("Task worktrees of a repo with their branch, commits ahead of base, and dirty files")
    .requiredOption("-r, --repo <path>", "repository")
    .option("--base <branch>", "base branch to compare against (default: the repo's current branch)")
    .option("--json", "JSON output")
    .action((options: { repo: string; base?: string; json?: boolean }) => {
      try {
        const repo = resolve(options.repo);
        const base = options.base ?? currentBranch(repo);
        const rows = listWorktrees(repo)
          .filter((w) => w.branch.startsWith("openfde/"))
          .map((w) => worktreeStatus(w.path, base));
        if (options.json) console.log(JSON.stringify({ repo, base, worktrees: rows }));
        else if (rows.length === 0) console.log(`No task worktrees in ${repo}.`);
        else
          for (const r of rows) {
            console.log(`${r.branch.padEnd(32)} +${r.ahead} commit(s)  ${r.dirty} dirty  ${r.path}${r.shortstat ? `\n    ${r.shortstat}` : ""}`);
          }
      } catch (error) {
        fail(error);
      }
    });

  wt
    .command("open <taskId>")
    .description("Create (or find) the task's worktree and print its path — cd there to review the agent's work")
    .option("-e, --engagement <slug>", "target engagement (defaults to current)")
    .requiredOption("-r, --repo <path>", "repository")
    .option("--base <branch>", "branch to fork from when creating")
    .option("--json", "JSON output")
    .action((taskId: string, options: { engagement?: string; repo: string; base?: string; json?: boolean }) => {
      try {
        const info = withLedger(options.engagement, (_db, slug) =>
          ensureWorktree({ repo: options.repo, engagement: slug, taskId, base: options.base }),
        );
        if (options.json) console.log(JSON.stringify(info));
        else console.log(info.path);
      } catch (error) {
        fail(error);
      }
    });

  wt
    .command("remove <taskId>")
    .description("Remove the task's worktree (refuses to drop uncommitted or unmerged work unless --force)")
    .option("-e, --engagement <slug>", "target engagement (defaults to current)")
    .requiredOption("-r, --repo <path>", "repository")
    .option("--base <branch>", "base branch used to judge whether commits are merged")
    .option("-f, --force", "remove even with uncommitted changes or unmerged commits")
    .action((taskId: string, options: { engagement?: string; repo: string; base?: string; force?: boolean }) => {
      try {
        withLedger(options.engagement, (db) => {
          const active = listRuns(db, { taskId, active: true });
          if (active.length > 0) throw new Error(`run ${active[0]!.id} is still ${active[0]!.status} in that worktree`);
          const run = listRuns(db, { taskId }).find((r) => r.worktree);
          if (!run?.worktree) throw new Error(`no worktree recorded for task ${taskId}`);
          removeWorktree(resolve(options.repo), run.worktree, { force: options.force, base: options.base });
          console.log(`Removed ${run.worktree}`);
        });
      } catch (error) {
        fail(error);
      }
    });
}
