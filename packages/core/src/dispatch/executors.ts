import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Executors (DESIGN 4.6, Mode A component 1): how the runner talks to a
 * coding agent. Every supported agent is driven in its headless, structured
 * mode — `claude -p --output-format stream-json` and `codex exec --json` —
 * never by scraping a terminal. Each executor turns the agent's native event
 * stream into one normalized AgentEvent stream, so the runner, the log, and
 * the UI understand exactly one shape.
 */

export type AgentEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "message"; text: string }
  | { kind: "tool"; name: string; input: string }
  | { kind: "tool_result"; ok: boolean }
  | { kind: "stderr"; text: string }
  | { kind: "error"; text: string }
  | {
      kind: "result";
      ok: boolean;
      sessionId?: string;
      costUsd?: number;
      turns?: number;
      text?: string;
    };

export type PermissionLevel = "plan" | "edit" | "bypass";

export interface SpawnInput {
  cwd: string;
  prompt: string;
  /** Continue an earlier session (follow-up) instead of starting fresh */
  resumeSessionId?: string;
  permission: PermissionLevel;
  maxTurns?: number;
  model?: string;
  env: NodeJS.ProcessEnv;
}

export interface AgentProcess {
  pid: number | null;
  events: AsyncIterable<AgentEvent>;
  /** Resolves with the exit code once the process is gone */
  exit: Promise<number | null>;
  kill(): void;
}

export interface Executor {
  readonly name: string;
  /** The binary the executor needs on PATH */
  readonly binary: string;
  spawn(input: SpawnInput): AgentProcess;
}

/* ---------------- Claude Code ---------------- */

/** Tools a spawned Claude Code may use without asking; the rest follows --permission-mode */
export const CLAUDE_ALLOWED_TOOLS = ["Bash(openfde:*)", "Bash(git:*)", "Read", "Grep", "Glob", "Edit", "Write"];

export function claudeArgs(input: Omit<SpawnInput, "cwd" | "env">): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (input.permission === "bypass") args.push("--dangerously-skip-permissions");
  else {
    args.push("--permission-mode", input.permission === "plan" ? "plan" : "acceptEdits");
    args.push("--allowedTools", ...CLAUDE_ALLOWED_TOOLS);
  }
  if (input.maxTurns) args.push("--max-turns", String(input.maxTurns));
  if (input.model) args.push("--model", input.model);
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  return args;
}

/** One line of `claude --output-format stream-json` → zero or more normalized events */
export function parseClaudeLine(line: string): AgentEvent[] {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = raw.type as string | undefined;
  if (type === "system" && raw.subtype === "init" && typeof raw.session_id === "string") {
    return [{ kind: "session", sessionId: raw.session_id }];
  }
  if (type === "assistant") {
    const message = raw.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message!.content as Record<string, unknown>[]) : [];
    const events: AgentEvent[] = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        events.push({ kind: "message", text: block.text });
      } else if (block.type === "tool_use") {
        events.push({
          kind: "tool",
          name: String(block.name ?? "tool"),
          input: summarizeInput(block.input),
        });
      }
    }
    return events;
  }
  if (type === "user") {
    const message = raw.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message!.content as Record<string, unknown>[]) : [];
    return content
      .filter((b) => b.type === "tool_result")
      .map((b) => ({ kind: "tool_result", ok: b.is_error !== true }) as AgentEvent);
  }
  if (type === "result") {
    return [
      {
        kind: "result",
        ok: raw.is_error !== true && (raw.subtype === undefined || raw.subtype === "success"),
        sessionId: typeof raw.session_id === "string" ? raw.session_id : undefined,
        costUsd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : undefined,
        turns: typeof raw.num_turns === "number" ? raw.num_turns : undefined,
        text: typeof raw.result === "string" ? raw.result : undefined,
      },
    ];
  }
  return [];
}

export class ClaudeCodeExecutor implements Executor {
  readonly name = "claude-code";
  readonly binary = "claude";

  spawn(input: SpawnInput): AgentProcess {
    return spawnLineProcess(this.binary, claudeArgs(input), input, parseClaudeLine);
  }
}

/* ---------------- Codex ---------------- */

export function codexArgs(input: Omit<SpawnInput, "cwd" | "env">): string[] {
  const args = ["exec"];
  if (input.resumeSessionId) args.push("resume", input.resumeSessionId);
  args.push("--json", "--skip-git-repo-check");
  if (input.permission === "bypass") args.push("--dangerously-bypass-approvals-and-sandbox");
  else args.push("-s", input.permission === "plan" ? "read-only" : "workspace-write");
  if (input.model) args.push("-m", input.model);
  args.push("-"); // prompt on stdin
  return args;
}

/** One line of `codex exec --json` → zero or more normalized events */
export function parseCodexLine(line: string): AgentEvent[] {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = raw.type as string | undefined;
  if (type === "thread.started" && typeof raw.thread_id === "string") {
    return [{ kind: "session", sessionId: raw.thread_id }];
  }
  if (type === "item.completed") {
    const item = (raw.item ?? {}) as Record<string, unknown>;
    switch (item.type) {
      case "agent_message":
        return typeof item.text === "string" && item.text.trim() ? [{ kind: "message", text: item.text }] : [];
      case "command_execution":
        return [
          { kind: "tool", name: "shell", input: String(item.command ?? "") },
          { kind: "tool_result", ok: item.exit_code === undefined || item.exit_code === 0 },
        ];
      case "file_change": {
        const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
        return [
          {
            kind: "tool",
            name: "edit",
            input: changes.map((c) => String(c.path ?? "")).filter(Boolean).join(", ") || "files",
          },
          { kind: "tool_result", ok: true },
        ];
      }
      case "error":
        return [{ kind: "error", text: String(item.message ?? "error") }];
      default:
        return [];
    }
  }
  if (type === "turn.completed") {
    return [{ kind: "result", ok: true }];
  }
  if (type === "turn.failed" || type === "error") {
    const error = (raw.error ?? {}) as Record<string, unknown>;
    return [
      { kind: "result", ok: false, text: String(error.message ?? raw.message ?? "turn failed") },
    ];
  }
  return [];
}

export class CodexExecutor implements Executor {
  readonly name = "codex";
  readonly binary = "codex";

  spawn(input: SpawnInput): AgentProcess {
    return spawnLineProcess(this.binary, codexArgs(input), input, parseCodexLine);
  }
}

/* ---------------- shared process plumbing ---------------- */

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object") return String(input).slice(0, 200);
  const obj = input as Record<string, unknown>;
  const preferred = ["command", "file_path", "path", "pattern", "query", "description", "prompt"];
  for (const key of preferred) {
    if (typeof obj[key] === "string") return (obj[key] as string).replace(/\s+/g, " ").slice(0, 200);
  }
  return JSON.stringify(obj).slice(0, 200);
}

/**
 * Spawn a headless agent in its own process group (so the whole tree can be
 * killed), feed the prompt on stdin, and turn stdout lines into events.
 */
export function spawnLineProcess(
  binary: string,
  args: string[],
  input: SpawnInput,
  parse: (line: string) => AgentEvent[],
): AgentProcess {
  const child: ChildProcess = spawn(binary, args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdin?.end(input.prompt);

  const queue: AgentEvent[] = [];
  let waiting: ((value: IteratorResult<AgentEvent>) => void) | null = null;
  let finished = false;
  const push = (event: AgentEvent) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: event, done: false });
    } else queue.push(event);
  };
  const finish = () => {
    finished = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: undefined as unknown as AgentEvent, done: true });
    }
  };

  if (child.stdout) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      for (const event of parse(line)) push(event);
    });
  }
  if (child.stderr) {
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.trim()) push({ kind: "stderr", text: line });
    });
  }

  const exit = new Promise<number | null>((resolve) => {
    child.on("error", (error) => {
      push({ kind: "error", text: `failed to start ${binary}: ${error.message}` });
      finish();
      resolve(null);
    });
    child.on("close", (code) => {
      finish();
      resolve(code);
    });
  });

  const events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<AgentEvent>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
          if (finished) return Promise.resolve({ value: undefined as unknown as AgentEvent, done: true });
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
      };
    },
  };

  return {
    pid: child.pid ?? null,
    events,
    exit,
    kill() {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    },
  };
}

/* ---------------- offline executor ---------------- */

export interface MockScript {
  /** Events to emit, in order; a "result" event ends the run */
  events: AgentEvent[];
  /** Runs before the events are emitted — tests use it to simulate edits/commits in the worktree */
  act?: (input: SpawnInput) => void | Promise<void>;
  exitCode?: number;
}

/** Deterministic executor for tests and dry runs: no process, scripted events. */
export class MockExecutor implements Executor {
  readonly name = "mock";
  readonly binary = "mock";
  readonly prompts: SpawnInput[] = [];
  constructor(private readonly script: MockScript | ((input: SpawnInput) => MockScript)) {}

  spawn(input: SpawnInput): AgentProcess {
    this.prompts.push(input);
    const script = typeof this.script === "function" ? this.script(input) : this.script;
    let killed = false;
    const events: AsyncIterable<AgentEvent> = {
      async *[Symbol.asyncIterator]() {
        await script.act?.(input);
        for (const event of script.events) {
          if (killed) return;
          yield event;
        }
      },
    };
    return {
      pid: null,
      events,
      exit: Promise.resolve(script.exitCode ?? 0),
      kill() {
        killed = true;
      },
    };
  }
}

export const EXECUTORS: Record<string, () => Executor> = {
  "claude-code": () => new ClaudeCodeExecutor(),
  claude: () => new ClaudeCodeExecutor(),
  codex: () => new CodexExecutor(),
};

export function executorByName(name: string): Executor {
  const factory = EXECUTORS[name];
  if (!factory) throw new Error(`unknown agent "${name}" (known: claude, codex)`);
  return factory();
}
