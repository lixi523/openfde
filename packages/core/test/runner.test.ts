import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupEnv, teardownEnv, type TestEnv } from "./helpers.js";
import {
  MockExecutor,
  buildRunPrompt,
  claudeArgs,
  ensureCliOnPath,
  codexArgs,
  createTask,
  ensureWorktree,
  followUpRun,
  getTask,
  ingestEpisode,
  latestRun,
  listRuns,
  listWorktrees,
  parseClaudeLine,
  parseCodexLine,
  parseExitMarker,
  removeWorktree,
  resolveEngagement,
  runReadyTasks,
  runTask,
  taskEvents,
  taskNote,
  transitionTask,
  worktreeStatus,
  runExtraction,
  MockExtractor,
  type AgentEvent,
  type SpawnInput,
} from "../src/index.js";

let env: TestEnv;
let repo: string;

function sh(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "openfde-repo-"));
  sh(["init", "-q", "-b", "main"], dir);
  sh(["config", "user.email", "t@example.com"], dir);
  sh(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "README.md"), "# demo\n");
  sh(["add", "."], dir);
  sh(["commit", "-q", "-m", "init"], dir);
  return dir;
}

beforeEach(() => {
  env = setupEnv();
  repo = makeRepo();
});
afterEach(() => {
  teardownEnv(env);
  rmSync(repo, { recursive: true, force: true });
});
const db = () => env.db;

const done = (summary: string): AgentEvent[] => [
  { kind: "session", sessionId: "sess-1" },
  { kind: "tool", name: "Bash", input: "git status" },
  { kind: "tool_result", ok: true },
  { kind: "message", text: `All good.\n\nDONE: ${summary}` },
  { kind: "result", ok: true, sessionId: "sess-1", costUsd: 0.42, turns: 3 },
];

/** Simulate the agent doing real work: write a file and commit it in its worktree */
function commitIn(input: SpawnInput, file = "feature.ts"): void {
  writeFileSync(join(input.cwd, file), "export const x = 1;\n");
  sh(["add", "."], input.cwd);
  sh(["-c", "user.email=a@example.com", "-c", "user.name=agent", "commit", "-q", "-m", "agent work"], input.cwd);
}

describe("worktree manager", () => {
  it("creates one worktree per task on its own branch, reuses it, and reports status", () => {
    const wt = ensureWorktree({ repo, engagement: "acme-corp", taskId: "task_abc123", base: "main" });
    expect(wt.branch).toBe("openfde/abc123");
    expect(wt.path).toContain(join("engagements", "acme-corp", "worktrees", "task_abc123"));
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    expect(listWorktrees(repo).map((w) => w.branch)).toContain("openfde/abc123");

    const again = ensureWorktree({ repo, engagement: "acme-corp", taskId: "task_abc123" });
    expect(again.path).toBe(wt.path);

    writeFileSync(join(wt.path, "new.txt"), "x");
    let status = worktreeStatus(wt.path, "main");
    expect(status).toMatchObject({ dirty: 1, ahead: 0 });
    expect(() => removeWorktree(repo, wt.path)).toThrow(/uncommitted/);

    sh(["add", "."], wt.path);
    sh(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "w"], wt.path);
    status = worktreeStatus(wt.path, "main");
    expect(status.ahead).toBe(1);
    expect(status.shortstat).toContain("1 file changed");
    expect(() => removeWorktree(repo, wt.path)).toThrow(/unmerged/);

    removeWorktree(repo, wt.path, { force: true });
    expect(existsSync(wt.path)).toBe(false);
    // the branch with real commits survives a forced worktree removal
    expect(sh(["branch", "--list", "openfde/abc123"], repo)).toContain("openfde/abc123");
  });

  it("rejects non-repositories", () => {
    expect(() => ensureWorktree({ repo: tmpdir(), engagement: "acme-corp", taskId: "task_x" })).toThrow(/not a git repository/);
  });
});

describe("executor event normalization", () => {
  it("maps claude stream-json lines", () => {
    expect(parseClaudeLine('{"type":"system","subtype":"init","session_id":"s1","cwd":"/x"}')).toEqual([
      { kind: "session", sessionId: "s1" },
    ]);
    expect(
      parseClaudeLine(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"},{"type":"tool_use","name":"Bash","input":{"command":"ls -la","description":"list"}}]}}',
      ),
    ).toEqual([
      { kind: "message", text: "hi" },
      { kind: "tool", name: "Bash", input: "ls -la" },
    ]);
    expect(parseClaudeLine('{"type":"user","message":{"content":[{"type":"tool_result","is_error":true}]}}')).toEqual([
      { kind: "tool_result", ok: false },
    ]);
    expect(
      parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"session_id":"s1","total_cost_usd":0.19,"num_turns":2,"result":"DONE: ok"}'),
    ).toEqual([{ kind: "result", ok: true, sessionId: "s1", costUsd: 0.19, turns: 2, text: "DONE: ok" }]);
    expect(parseClaudeLine('{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"s1"}')[0]).toMatchObject({ ok: false });
    expect(parseClaudeLine('{"type":"rate_limit_event"}')).toEqual([]);
    expect(parseClaudeLine("not json")).toEqual([]);
  });

  it("maps codex exec --json lines", () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"t1"}')).toEqual([{ kind: "session", sessionId: "t1" }]);
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"DONE: x"}}')).toEqual([
      { kind: "message", text: "DONE: x" },
    ]);
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"command_execution","command":"npm test","exit_code":1}}')).toEqual([
      { kind: "tool", name: "shell", input: "npm test" },
      { kind: "tool_result", ok: false },
    ]);
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a.ts"},{"path":"b.ts"}]}}')[0]).toEqual({
      kind: "tool",
      name: "edit",
      input: "a.ts, b.ts",
    });
    expect(parseCodexLine('{"type":"turn.completed","usage":{}}')).toEqual([{ kind: "result", ok: true }]);
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"boom"}}')).toEqual([{ kind: "result", ok: false, text: "boom" }]);
  });

  it("builds headless command lines for both agents", () => {
    const claude = claudeArgs({ prompt: "p", permission: "edit", maxTurns: 5, resumeSessionId: "s9" });
    expect(claude.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(claude).toContain("acceptEdits");
    expect(claude).toContain("Bash(openfde:*)");
    expect(claude.join(" ")).toContain("--max-turns 5");
    expect(claude.join(" ")).toContain("--resume s9");
    expect(claudeArgs({ prompt: "p", permission: "bypass" })).toContain("--dangerously-skip-permissions");
    expect(claudeArgs({ prompt: "p", permission: "plan" })).toContain("plan");

    expect(codexArgs({ prompt: "p", permission: "edit" })).toEqual(["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-"]);
    expect(codexArgs({ prompt: "p", permission: "plan", resumeSessionId: "t1" }).slice(0, 3)).toEqual(["exec", "resume", "t1"]);
    expect(codexArgs({ prompt: "p", permission: "bypass" })).toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});

describe("exit markers and prompt", () => {
  it("reads the last marker line, case-insensitively", () => {
    expect(parseExitMarker("did things\n\nDONE: shipped the thing")).toEqual({ marker: "DONE", detail: "shipped the thing" });
    expect(parseExitMarker("blocked: no DB access")).toEqual({ marker: "BLOCKED", detail: "no DB access" });
    expect(parseExitMarker("NEEDS_HUMAN: which region?\n")).toEqual({ marker: "NEEDS_HUMAN", detail: "which region?" });
    expect(parseExitMarker("I am done with step one")).toBeNull();
    expect(parseExitMarker(undefined)).toBeNull();
  });

  it("puts protocol, worktree, and the cited context pack in the prompt", () => {
    const prompt = buildRunPrompt({
      engagement: "acme-corp",
      runId: "run_1",
      branch: "openfde/x",
      cwd: "/wt",
      executorName: "claude-code",
      contextMarkdown: "# Task context: Do it\n\n- fact one\n  source: interview://a",
    });
    expect(prompt).toContain("branch `openfde/x`");
    expect(prompt).toContain("Constraints outrank the task wording");
    expect(prompt).toContain("openfde remember");
    expect(prompt).toContain("`DONE: ");
    expect(prompt).toContain("`NEEDS_HUMAN: ");
    expect(prompt).toContain("source: interview://a");
  });
});

describe("runner", () => {
  async function seedTask(): Promise<string> {
    ingestEpisode(db(), {
      kind: "message",
      content: "Constraint:no-prod-access|BLOCKS|Workflow:reconciliation :: Security forbids direct production access",
      sourceUri: "interview://onsite",
    });
    await runExtraction(db(), new MockExtractor());
    return createTask(db(), { title: "Automate the CSV cleanup", criteria: "Runs unattended", sourceUri: "interview://onsite#pain" }).id;
  }

  it("claims, opens a worktree, hands the agent the context pack, and moves the task to review on DONE", async () => {
    const taskId = await seedTask();
    const executor = new MockExecutor({ events: done("cleanup automated, tests green"), act: (i) => commitIn(i) });
    const seen: AgentEvent[] = [];
    const outcome = await runTask(db(), "acme-corp", taskId, {
      executor,
      repo,
      base: "main",
      onEvent: (e) => seen.push(e),
    });

    expect(outcome.task.status).toBe("review");
    expect(outcome.run.status).toBe("done");
    expect(outcome.run.exit_marker).toBe("DONE");
    expect(outcome.run.summary).toBe("cleanup automated, tests green");
    expect(outcome.run.session_id).toBe("sess-1");
    expect(outcome.run.cost_usd).toBe(0.42);
    expect(outcome.run.tool_calls).toBe(1);
    expect(outcome.run.branch).toBe(`openfde/${taskId.replace("task_", "")}`);
    expect(outcome.worktree?.ahead).toBe(1);
    expect(seen.map((e) => e.kind)).toEqual(["session", "tool", "tool_result", "message", "result"]);

    // the agent got the cited context pack, the protocol, and an environment pointing at the engagement
    const input = executor.prompts[0]!;
    expect(input.prompt).toContain("Security forbids direct production access");
    expect(input.prompt).toContain("Acceptance criteria");
    expect(input.prompt).toContain("Runs unattended");
    expect(input.env.OPENFDE_ENGAGEMENT).toBe("acme-corp");
    expect(input.env.OPENFDE_ACTOR).toBe("mock");
    expect(input.env.OPENFDE_TASK_ID).toBe(taskId);
    expect(input.cwd).toBe(outcome.run.worktree);

    // audit trail: claimed → running → review, with the run summary and diff stat on the note
    const events = taskEvents(db(), taskId).filter((e) => e.kind === "status").map((e) => e.to_status);
    expect(events).toEqual(["claimed", "running", "review"]);
    const reviewNote = taskEvents(db(), taskId).at(-1)!.note!;
    expect(reviewNote).toContain("DONE: cleanup automated");
    expect(reviewNote).toContain("1 commit(s) on openfde/");

    // the log holds every normalized event; the task note shows the run
    const log = readFileSync(outcome.run.log_path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log).toHaveLength(5);
    expect(log[0]).toMatchObject({ kind: "session", sessionId: "sess-1" });
    expect(taskNote(db(), taskId)).toContain("## Runs (1)");
    expect(taskNote(db(), taskId)).toContain("DONE: cleanup automated");
  });

  it("returns the task to ready on BLOCKED, keeps it running on NEEDS_HUMAN", async () => {
    const taskId = await seedTask();
    const blocked = await runTask(db(), "acme-corp", taskId, {
      executor: new MockExecutor({
        events: [{ kind: "message", text: "BLOCKED: constraint forbids prod access, need a staging DB" }, { kind: "result", ok: true }],
      }),
      repo,
      base: "main",
    });
    expect(blocked.run.status).toBe("blocked");
    expect(blocked.task.status).toBe("ready");
    expect(blocked.task.claimed_by).toBeNull();
    expect(taskEvents(db(), taskId).at(-1)!.note).toContain("BLOCKED: constraint forbids");

    const asking = await runTask(db(), "acme-corp", taskId, {
      executor: new MockExecutor({
        events: [{ kind: "session", sessionId: "s2" }, { kind: "message", text: "NEEDS_HUMAN: which bucket should the output land in?" }, { kind: "result", ok: true }],
      }),
      repo,
      base: "main",
    });
    expect(asking.run.status).toBe("needs_human");
    expect(asking.task.status).toBe("running");
    expect(taskEvents(db(), taskId).at(-1)!.note).toContain("openfde run followup");
  });

  it("treats a crashed agent as a failed run and frees the task", async () => {
    const taskId = await seedTask();
    const outcome = await runTask(db(), "acme-corp", taskId, {
      executor: new MockExecutor({ events: [{ kind: "error", text: "boom" }], exitCode: 1 }),
      repo,
      base: "main",
    });
    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.exit_code).toBe(1);
    expect(outcome.task.status).toBe("ready");
  });

  it("refuses tasks that are not ready or claimed", async () => {
    const taskId = await seedTask();
    transitionTask(db(), taskId, "claimed", { actor: "x" });
    transitionTask(db(), taskId, "running", { actor: "x" });
    await expect(runTask(db(), "acme-corp", taskId, { executor: new MockExecutor({ events: [] }), repo })).rejects.toThrow(/is running/);
  });

  it("follows up in the same session and worktree, and reworks a rejected task with the same agent", async () => {
    const taskId = await seedTask();
    const first = await runTask(db(), "acme-corp", taskId, {
      executor: new MockExecutor({ events: done("v1"), act: (i) => commitIn(i, "a.ts") }),
      repo,
      base: "main",
    });
    transitionTask(db(), taskId, "rejected", { actor: "fde", note: "tests missing" });

    const executor = new MockExecutor({ events: done("v2 with tests"), act: (i) => commitIn(i, "a.test.ts") });
    const second = await followUpRun(db(), "acme-corp", first.run.id, "Please add tests for the cleanup", { executor, base: "main" });

    expect(executor.prompts[0]!.resumeSessionId).toBe("sess-1");
    expect(executor.prompts[0]!.cwd).toBe(first.run.worktree);
    expect(executor.prompts[0]!.prompt).toContain("Please add tests for the cleanup");
    expect(second.run.parent_run_id).toBe(first.run.id);
    expect(second.task.status).toBe("review");
    expect(second.worktree?.ahead).toBe(2);
    expect(listRuns(db(), { taskId })).toHaveLength(2);
    expect(latestRun(db(), taskId)!.id).toBe(second.run.id);
    const statuses = taskEvents(db(), taskId).filter((e) => e.kind === "status").map((e) => e.to_status);
    expect(statuses).toEqual(["claimed", "running", "review", "rejected", "ready", "claimed", "running", "review"]);
  });

  it("fans out over ready tasks up to the concurrency cap", async () => {
    await seedTask();
    createTask(db(), { title: "second" });
    createTask(db(), { title: "third" });
    const executor = new MockExecutor((input) => ({ events: done(`did ${input.env.OPENFDE_TASK_ID}`) }));
    const outcomes = await runReadyTasks(db(), "acme-corp", { executor, repo, base: "main", max: 2 });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.task.status === "review")).toBe(true);
    expect(new Set(outcomes.map((o) => o.run.worktree)).size).toBe(2);
    expect(listWorktrees(repo).filter((w) => w.branch.startsWith("openfde/"))).toHaveLength(2);
    const remaining = await runReadyTasks(db(), "acme-corp", { executor, repo, base: "main", max: 2 });
    expect(remaining).toHaveLength(1);
  });

  it("kills a stalled agent and frees the task", async () => {
    const taskId = await seedTask();
    const executor = new MockExecutor({
      events: [{ kind: "session", sessionId: "s" }],
      act: () => new Promise((r) => setTimeout(r, 150)),
    });
    const outcome = await runTask(db(), "acme-corp", taskId, { executor, repo, base: "main", stallMs: 40 });
    expect(outcome.run.status).toBe("killed");
    expect(outcome.run.summary).toContain("stall");
    expect(outcome.task.status).toBe("ready");
  });

  it("lets the spawned agent target the engagement through OPENFDE_ENGAGEMENT", () => {
    process.env.OPENFDE_ENGAGEMENT = "acme-corp";
    try {
      expect(resolveEngagement()).toBe("acme-corp");
    } finally {
      delete process.env.OPENFDE_ENGAGEMENT;
    }
    expect(() => {
      process.env.OPENFDE_ENGAGEMENT = "nope";
      try {
        resolveEngagement();
      } finally {
        delete process.env.OPENFDE_ENGAGEMENT;
      }
    }).toThrow(/does not exist/);
    expect(getTask(db(), "task_missing")).toBeNull();
  });
});

describe("cli shim for spawned agents", () => {
  it("prepends a shim that re-invokes the running CLI when openfde is not on PATH", () => {
    const env = ensureCliOnPath({ PATH: "/nonexistent-dir" }, env_home());
    expect(env.PATH!.split(":")[0]).toBe(join(env_home(), "bin"));
    const shim = readFileSync(join(env_home(), "bin", "openfde"), "utf8");
    expect(shim.startsWith("#!/bin/sh")).toBe(true);
    expect(shim).toContain(process.execPath);
    expect(shim).toContain(process.argv[1]!);
  });

  it("leaves the environment alone when openfde is already on PATH", () => {
    const dir = join(env_home(), "fake-bin");
    execFileSync("mkdir", ["-p", dir]);
    writeFileSync(join(dir, "openfde"), "#!/bin/sh\n", { mode: 0o755 });
    const env = ensureCliOnPath({ PATH: dir }, env_home());
    expect(env.PATH).toBe(dir);
  });
});

function env_home(): string {
  return env.home;
}
