import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir, worktreesDir } from "../engagement/paths.js";

/**
 * Worktree manager (DESIGN 4.6, Mode A component 2).
 *
 * One git worktree per task, on its own branch, so several agents can work
 * the same repository in parallel without stepping on each other or on the
 * engineer's checkout. Worktrees live under the engagement directory, not
 * inside the repo, so customer data isolation and handoff stay filesystem
 * operations. Plain `git` calls; no library.
 */

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
}

export interface WorktreeStatus {
  path: string;
  branch: string;
  base: string;
  /** Files modified/untracked and not committed */
  dirty: number;
  /** Commits on the branch that the base does not have */
  ahead: number;
  /** `git diff --shortstat base...HEAD`, empty when nothing committed */
  shortstat: string;
}

/** Compare paths through symlinks (macOS reports /private/var for /var) */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function isGitRepo(dir: string): boolean {
  try {
    return git(["rev-parse", "--is-inside-work-tree"], dir) === "true";
  } catch {
    return false;
  }
}

/** The branch the repo currently has checked out — the default base for task branches */
export function currentBranch(repo: string): string {
  const name = git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
  if (name === "HEAD") throw new Error(`${repo} is in detached HEAD state; pass --base <branch>`);
  return name;
}

export function branchExists(repo: string, branch: string): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
    return true;
  } catch {
    return false;
  }
}

/** Branch name for a task: openfde/<task id without prefix> */
export function taskBranch(taskId: string): string {
  return `openfde/${taskId.replace(/^task_/, "")}`;
}

export function listWorktrees(repo: string): WorktreeInfo[] {
  const out = git(["worktree", "list", "--porcelain"], repo);
  const result: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) current = { path: line.slice(9) };
    else if (line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "") {
      if (current.path) result.push({ path: current.path, branch: current.branch ?? "(detached)", head: current.head ?? "" });
      current = {};
    }
  }
  if (current.path) result.push({ path: current.path, branch: current.branch ?? "(detached)", head: current.head ?? "" });
  return result;
}

export interface EnsureWorktreeInput {
  repo: string;
  engagement: string;
  taskId: string;
  /** Branch to fork from; defaults to the repo's current branch */
  base?: string;
}

/**
 * Create the task's worktree, or return it when it already exists (re-runs and
 * follow-ups keep working on the same branch).
 */
export function ensureWorktree(input: EnsureWorktreeInput): WorktreeInfo & { base: string } {
  const repo = resolve(input.repo);
  if (!isGitRepo(repo)) throw new Error(`${repo} is not a git repository`);
  const base = input.base ?? currentBranch(repo);
  const branch = taskBranch(input.taskId);
  const path = join(ensureDir(worktreesDir(input.engagement)), input.taskId);

  const existing = listWorktrees(repo).find((w) => samePath(w.path, path));
  if (existing) return { ...existing, path, base };

  if (existsSync(path)) {
    // a stale directory git no longer tracks (e.g. deleted repo state); clear it
    rmSync(path, { recursive: true, force: true });
  }
  if (branchExists(repo, branch)) git(["worktree", "add", path, branch], repo);
  else git(["worktree", "add", "-b", branch, path, base], repo);
  return { path, branch, head: git(["rev-parse", "HEAD"], path), base };
}

export function worktreeStatus(path: string, base: string): WorktreeStatus {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], path);
  const dirty = git(["status", "--porcelain"], path).split("\n").filter(Boolean).length;
  let ahead = 0;
  let shortstat = "";
  try {
    ahead = Number(git(["rev-list", "--count", `${base}..HEAD`], path));
    shortstat = ahead > 0 ? git(["diff", "--shortstat", `${base}...HEAD`], path) : "";
  } catch {
    /* base unknown in this worktree (deleted branch): report zero */
  }
  return { path, branch, base, dirty, ahead, shortstat };
}

export interface RemoveWorktreeOptions {
  /** Remove even when the worktree has uncommitted changes or unmerged commits */
  force?: boolean;
  base?: string;
}

/**
 * Remove a task worktree. Refuses when work would be lost (dirty files or
 * commits the base does not have) unless forced; the branch is deleted only
 * when it carries no commits of its own.
 */
export function removeWorktree(repo: string, path: string, options: RemoveWorktreeOptions = {}): void {
  const abs = resolve(path);
  const info = listWorktrees(repo).find((w) => samePath(w.path, abs));
  if (!info) {
    if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
    return;
  }
  const base = options.base ?? currentBranch(repo);
  const status = worktreeStatus(abs, base);
  if (!options.force && (status.dirty > 0 || status.ahead > 0)) {
    throw new Error(
      `worktree ${abs} has ${status.dirty} uncommitted file(s) and ${status.ahead} unmerged commit(s); merge the branch "${status.branch}" first or pass --force`,
    );
  }
  git(["worktree", "remove", ...(options.force ? ["--force"] : []), abs], repo);
  if (status.ahead === 0 && info.branch !== "(detached)") {
    try {
      git(["branch", "-D", info.branch], repo);
    } catch {
      /* branch checked out elsewhere or already gone */
    }
  }
}
