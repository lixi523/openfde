---
name: openfde
description: >-
  Operate a customer engagement's shared memory and task ledger through the
  `openfde` CLI. Use this skill whenever you work inside a repository or
  engagement that has an FDE.md or an openfde ledger: before answering
  questions about the customer ("what did they say about X", "who owns Y"),
  before starting implementation work (claim the task, pull its context),
  when you learn something worth remembering, or when you finish work.
  Trigger phrases: "check the engagement memory", "claim a task", "what do we
  know about", "record this finding", "read FDE.md".
---

# openfde — read FDE.md first

This stub exists so you can find the real guide. The guide is **FDE.md**, the
engagement's deployment brief: who we serve, the mission, the constraints you
must never violate, which data to trust, who decides, and the exact protocol
for using the shared memory and the task ledger. It is generated from the
engagement ledger, so it can never drift from the data it describes.
Spec: https://fde.md

## Find the brief

1. If the repository has an `FDE.md` at its root, read it — all of it.
2. Otherwise, or if it looks stale, generate it: `openfde fde` (prints) or
   `openfde fde --write` (writes `./FDE.md`, keeping the FDE's notes block).
3. If the command fails with "no engagement selected", ask the human which
   engagement to use — never create one on your own.

Then follow FDE.md. `openfde --help` and `openfde <verb> --help` are the
authoritative reference for every command; all of them accept `--json`.

## Install the CLI (one-time, when `openfde` is missing)

Prerequisites: Node.js >= 22 and pnpm.

```sh
git clone https://github.com/memovai/openfde.git
cd openfde && pnpm install && pnpm -C apps/cli build
npm link ./apps/cli        # exposes the `openfde` binary on PATH
openfde --version
```

Environment: `ANTHROPIC_API_KEY` only for `extract`, `research`, and `eval`
without `--mock`; `OPENFDE_ACTOR` is your name in audit trails (set it to
your agent name); `OPENFDE_HOME` moves the data directory.

To install this skill: copy this directory to `.claude/skills/openfde/`
(project) or `~/.claude/skills/openfde/` (user).

## The two rules that survive any brief

1. **Cite or it didn't happen.** Facts come from `openfde recall` with their
   sources, never from your priors. Write back with `openfde remember
   "<fact>" --source <uri>`; the source is mandatory.
2. **Constraints outrank the task wording.** If a task conflicts with a
   recorded constraint, stop, note it on the task, and wait.
