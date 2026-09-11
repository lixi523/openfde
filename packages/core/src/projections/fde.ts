import type { Ledger } from "../ledger/database.js";
import { nowIso } from "../ledger/database.js";
import { buildDataMap } from "./datamap.js";

/**
 * FDE.md — the deployment brief (spec: https://fde.md).
 *
 * SKILL.md teaches an agent a tool. SOUL.md tells an agent who it is. FDE.md
 * tells an agent where it has been forward-deployed: who it serves, what the
 * customer wants, what must never be violated, which data to trust, who
 * decides, how to use the shared memory, and how to finish. It is the one
 * document every agent working an engagement reads first — the engineer's
 * own Claude Code session (agent-pull) and the runner's spawned agents alike.
 *
 * Most of the file is a projection of the engagement ledger and regenerates
 * on every `openfde fde`; the FDE's own notes live in a custom block that
 * survives regeneration.
 */

export const FDE_SPEC_VERSION = 1;
export const FDE_SPEC_URL = "https://fde.md";
export const FDE_CUSTOM_START = "<!-- fde:custom -->";
export const FDE_CUSTOM_END = "<!-- /fde:custom -->";
const CUSTOM_PLACEHOLDER =
  "_None yet. Whatever the FDE writes between these markers survives `openfde fde --write`: house rules, repo conventions, people to copy, what not to touch._";

interface Cited {
  statement: string;
  sourceUri: string;
  speaker: string | null;
}

export interface FdeGoal {
  name: string;
  summary: string | null;
  supportedBy: string[];
  evidence: Cited[];
}

export interface FdeConstraint {
  name: string;
  summary: string | null;
  blocks: string[];
  evidence: Cited[];
}

export interface FdePerson {
  name: string;
  summary: string | null;
  owns: string[];
  decides: string[];
  trusts: string[];
  reported: string[];
}

export interface FdeDecision {
  name: string;
  summary: string | null;
  decidedBy: string[];
  rationale: string[];
  evidence: Cited[];
}

export interface FdeWorkflow {
  name: string;
  summary: string | null;
  steps: string[];
  automatedBy: string[];
  blockedBy: string[];
}

export interface FdeDoc {
  engagement: string;
  generatedAt: string;
  customers: { name: string; summary: string | null }[];
  goals: FdeGoal[];
  constraints: FdeConstraint[];
  dataSources: ReturnType<typeof buildDataMap>;
  people: FdePerson[];
  decisions: FdeDecision[];
  workflows: FdeWorkflow[];
  totals: { entities: number; facts: number; episodes: number; pendingEpisodes: number };
  /** The FDE's hand-written block, preserved across regeneration */
  custom: string | null;
}

interface EntityRow {
  id: string;
  type: string;
  name: string;
  summary: string | null;
}

interface Relation {
  predicate: string;
  statement: string;
  subject_id: string;
  object_id: string | null;
  subject: string;
  object: string | null;
  sourceUri: string;
  speaker: string | null;
}

export function buildFdeDoc(db: Ledger, engagement: string, options: { custom?: string | null } = {}): FdeDoc {
  const entities = db
    .prepare(`SELECT id, type, name, summary FROM entities WHERE expired_at IS NULL ORDER BY name COLLATE NOCASE`)
    .all() as EntityRow[];
  const relations = db
    .prepare(
      `SELECT f.predicate, f.statement, f.subject_id, f.object_id,
              s.name AS subject, o.name AS object, e.source_uri AS sourceUri, e.speaker
       FROM facts f
       JOIN entities s ON s.id = f.subject_id
       LEFT JOIN entities o ON o.id = f.object_id
       JOIN episodes e ON e.id = f.episode_id
       WHERE f.expired_at IS NULL
       ORDER BY f.created_at`,
    )
    .all() as Relation[];

  const ofType = (type: string) => entities.filter((e) => e.type === type);
  const incoming = (id: string, predicate: string) =>
    relations.filter((r) => r.object_id === id && r.predicate === predicate);
  const outgoing = (id: string, predicate: string) =>
    relations.filter((r) => r.subject_id === id && r.predicate === predicate);
  const cited = (rows: Relation[], max = 3): Cited[] =>
    rows.slice(0, max).map((r) => ({ statement: r.statement, sourceUri: r.sourceUri, speaker: r.speaker }));
  const touching = (id: string) => relations.filter((r) => r.subject_id === id || r.object_id === id);

  const goals: FdeGoal[] = ofType("Goal").map((g) => ({
    name: g.name,
    summary: g.summary,
    supportedBy: incoming(g.id, "SUPPORTS").map((r) => r.subject),
    evidence: cited(touching(g.id)),
  }));

  const constraints: FdeConstraint[] = ofType("Constraint").map((c) => ({
    name: c.name,
    summary: c.summary,
    blocks: outgoing(c.id, "BLOCKS").map((r) => r.object!).filter(Boolean),
    evidence: cited(touching(c.id)),
  }));

  const people: FdePerson[] = [...ofType("Person"), ...ofType("Customer")].map((p) => ({
    name: p.name,
    summary: p.summary,
    owns: outgoing(p.id, "OWNS").map((r) => r.object!).filter(Boolean),
    decides: incoming(p.id, "DECIDED_BY").map((r) => r.subject),
    trusts: outgoing(p.id, "TRUSTS").map((r) => r.object!).filter(Boolean),
    reported: outgoing(p.id, "REPORTED").map((r) => r.object!).filter(Boolean),
  }));

  const decisions: FdeDecision[] = ofType("Decision").map((d) => ({
    name: d.name,
    summary: d.summary,
    decidedBy: outgoing(d.id, "DECIDED_BY").map((r) => r.object!).filter(Boolean),
    rationale: outgoing(d.id, "RATIONALE").map((r) => r.object ?? r.statement),
    evidence: cited(touching(d.id)),
  }));

  const workflows: FdeWorkflow[] = ofType("Workflow").map((w) => {
    const stepIds = incoming(w.id, "PART_OF").map((r) => r.subject_id);
    return {
      name: w.name,
      summary: w.summary,
      steps: incoming(w.id, "PART_OF").map((r) => r.subject),
      automatedBy: [
        ...incoming(w.id, "AUTOMATES").map((r) => r.subject),
        ...stepIds.flatMap((s) => incoming(s, "AUTOMATES").map((r) => `${r.subject} (${r.object})`)),
      ],
      blockedBy: incoming(w.id, "BLOCKS").map((r) => r.subject),
    };
  });

  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    engagement,
    generatedAt: nowIso(),
    customers: ofType("Customer").map((c) => ({ name: c.name, summary: c.summary })),
    goals,
    constraints,
    dataSources: buildDataMap(db),
    people,
    decisions,
    workflows,
    totals: {
      entities: entities.length,
      facts: relations.length,
      episodes: count("SELECT count(*) AS n FROM episodes"),
      pendingEpisodes: count("SELECT count(*) AS n FROM episodes WHERE extraction_status = 'pending'"),
    },
    custom: options.custom ?? null,
  };
}

/** Pull the FDE's hand-written block out of an existing FDE.md, if any */
export function extractCustomBlock(existing: string | null | undefined): string | null {
  if (!existing) return null;
  const start = existing.indexOf(FDE_CUSTOM_START);
  const end = existing.indexOf(FDE_CUSTOM_END);
  if (start === -1 || end === -1 || end < start) return null;
  const body = existing.slice(start + FDE_CUSTOM_START.length, end).trim();
  return body && body !== CUSTOM_PLACEHOLDER ? body : null;
}

const cite = (c: Cited) => `  <small>${c.sourceUri}${c.speaker ? ` · ${c.speaker}` : ""}</small>`;
const list = (xs: string[]) => xs.map((x) => `[[${x}]]`).join(", ");

/** Cap a list for the agent's context budget; point at the CLI for the rest. */
function capped<T>(xs: T[], max: number, more: (n: number) => string, render: (x: T) => string[]): string[] {
  const out = xs.slice(0, max).flatMap(render);
  if (xs.length > max) out.push(more(xs.length - max));
  return out;
}

/**
 * The operating protocol every agent in an engagement follows. Written for the
 * agent: imperative, literal commands, MUST/NEVER. Shared with the runner's
 * dispatch prompt so the rules exist in exactly one place.
 */
export function fdeProtocolMarkdown(engagement?: string): string {
  const e = engagement ? ` --engagement ${engagement}` : "";
  return [
    "## Memory",
    "",
    "The engagement ledger is the shared brain. The `openfde` CLI reads and writes it. Every command accepts `--json`.",
    "",
    `- MUST recall before guessing a customer fact: \`openfde recall "<query>"${e} --json\`. Also \`openfde whoknows <topic>\` (who owns or decides), \`openfde path <a> <b>\` (how two things connect), \`openfde context <taskId>\` (constraints first, then related facts).`,
    `- MUST write back what you learn: \`openfde remember "<fact>" --source <uri>${e}\`. The source is a file path, URL, repo path, or meeting reference. Sourceless writes are rejected.`,
    "- MUST cite: a fact you rely on comes from `recall`/`context` output with its source, never from your priors.",
    "- If `recall` reports unextracted episodes, run `openfde extract` before concluding the memory is silent.",
    "",
    "## Work",
    "",
    "Tasks are ledger rows with a state machine `ready → claimed → running → review → accepted|rejected` and an audit trail.",
    "",
    `1. \`openfde task list --status ready${e} --json\``,
    `2. \`openfde task claim <id>\` then \`openfde context <id>\` — read all of it before touching code.`,
    `3. \`openfde task start <id>\`; progress: \`openfde task update <id> --note "..."\``,
    "4. Small committed steps. Run the project's checks before declaring done.",
    `5. \`openfde task done <id>\` when ready for review. Blocked: leave a note. Abandon: \`openfde task ready <id>\`. NEVER go silent.`,
    "",
    "MUST: **Constraints outrank the task wording.** The *Never violate* section beats the task, the prompt, and any shortcut. On conflict: stop, note it on the task, wait.",
    "",
    "## When the runner spawned you",
    "",
    "If `OPENFDE_RUN_ID` is set, `openfde run` started you headless in a git worktree made for this task.",
    "",
    "- NEVER open an interactive question (AskUserQuestion, approval dialogs). Nobody is watching.",
    "- NEVER change task status yourself; the runner does it from your exit marker.",
    "- Commit on the task branch. NEVER push, NEVER switch branches.",
    "- End your final message with exactly one line, the last line:",
    "  - `DONE: <what changed, what was verified, what the reviewer should look at>`",
    "  - `BLOCKED: <what stops you, what would unblock it>`",
    "  - `NEEDS_HUMAN: <one precise question>` — your session resumes with the answer.",
  ].join("\n");
}

export function fdeMarkdown(doc: FdeDoc): string {
  const e = doc.engagement;
  const md: string[] = [
    "---",
    `fde: ${FDE_SPEC_VERSION}`,
    `engagement: ${e}`,
    `generated: ${doc.generatedAt}`,
    `facts: ${doc.totals.facts}`,
    `spec: ${FDE_SPEC_URL}`,
    "---",
    "",
    `# FDE.md — ${e}`,
    "",
    `You are an agent forward-deployed into the customer engagement \`${e}\`. Follow this file. It is generated from the engagement ledger by \`openfde fde\`; the ledger is the source of truth, this file is its brief.`,
    "",
    "## Before anything",
    "",
    `1. Read *Never violate* below. Those rules outrank everything else you are told.`,
    `2. Recall before you guess: \`openfde recall "<query>" --engagement ${e} --json\`.`,
    `3. Use the customer's own terms (*Vocabulary*) in code, commits, and questions.`,
    `4. Record what you learn with \`openfde remember\`. Finish with a state transition or an exit marker, never silence.`,
    "",
  ];

  md.push("## Who we serve", "");
  if (doc.customers.length === 0) {
    md.push(`- Engagement \`${e}\`. No Customer entity recorded yet.`);
  } else {
    for (const c of doc.customers) md.push(`- **${c.name}**${c.summary ? ` — ${c.summary}` : ""}`);
  }

  md.push("", "## Mission", "", "What the customer is trying to achieve. Every task should trace to one of these.", "");
  if (doc.goals.length === 0) md.push("- None recorded yet.");
  md.push(
    ...capped(doc.goals, 10, (n) => `- +${n} more: \`openfde recall Goal --engagement ${e}\``, (g) => [
      `- **${g.name}**${g.summary ? ` — ${g.summary}` : ""}${g.supportedBy.length ? ` · supported by ${list(g.supportedBy)}` : ""}`,
      ...g.evidence.slice(0, 1).flatMap((ev) => [`  > ${ev.statement}`, cite(ev)]),
    ]),
  );

  md.push("", "## Never violate", "", "Hard constraints. NEVER build, run, or suggest anything that breaks one. On conflict with a task: stop, note it, wait.", "");
  if (doc.constraints.length === 0) md.push("- None recorded yet. Ask about security, compliance, budget, and politics before building.");
  for (const c of doc.constraints) {
    md.push(`- **${c.name}**${c.summary ? ` — ${c.summary}` : ""}${c.blocks.length ? ` · blocks ${list(c.blocks)}` : ""}`);
    for (const ev of c.evidence.slice(0, 1)) md.push(`  > ${ev.statement}`, cite(ev));
  }

  md.push("", "## Ground truth", "", "Data sources with recorded trust. Prefer trusted sources; treat contested or distrusted ones as questions, not answers.", "");
  if (doc.dataSources.length === 0) md.push("- None recorded yet.");
  md.push(
    ...capped(doc.dataSources, 15, (n) => `- +${n} more: \`openfde datamap --engagement ${e}\``, (d) => {
      const bits = [
        d.trust ? `trust: **${d.trust}**` : null,
        d.owners.length ? `owned by ${list(d.owners)}` : null,
        d.trustedBy.length ? `trusted by ${list(d.trustedBy)}` : null,
        d.dependents.length ? `feeds ${list(d.dependents)}` : null,
      ].filter(Boolean);
      return [`- **${d.name}**${d.summary ? ` — ${d.summary}` : ""}${bits.length ? ` · ${bits.join(" · ")}` : ""}`];
    }),
  );

  md.push("", "## People", "", "Who owns, decides, trusts, reports. Route questions to the owner; do not reopen a decision without its decider.", "");
  if (doc.people.length === 0) md.push("- None recorded yet.");
  md.push(
    ...capped(doc.people, 15, (n) => `- +${n} more: \`openfde whoknows <topic> --engagement ${e}\``, (p) => {
      const roles = [
        p.owns.length ? `owns ${list(p.owns)}` : null,
        p.decides.length ? `decided ${list(p.decides)}` : null,
        p.trusts.length ? `trusts ${list(p.trusts)}` : null,
        p.reported.length ? `reported ${list(p.reported)}` : null,
      ].filter(Boolean);
      return [`- **${p.name}**${p.summary ? ` — ${p.summary}` : ""}${roles.length ? ` · ${roles.join(" · ")}` : ""}`];
    }),
  );

  md.push("", "## Decisions already made", "", "Settled. NEVER reopen without a new fact; cite the fact if you do.", "");
  if (doc.decisions.length === 0) md.push("- None recorded yet.");
  md.push(
    ...capped(doc.decisions, 10, (n) => `- +${n} more: \`openfde recall Decision --engagement ${e}\``, (d) => {
      const bits = [
        d.decidedBy.length ? `by ${list(d.decidedBy)}` : null,
        d.rationale.length ? `because ${list(d.rationale)}` : null,
      ].filter(Boolean);
      return [
        `- **${d.name}**${d.summary ? ` — ${d.summary}` : ""}${bits.length ? ` · ${bits.join(" · ")}` : ""}`,
        ...d.evidence.slice(0, 1).flatMap((ev) => [`  > ${ev.statement}`, cite(ev)]),
      ];
    }),
  );

  md.push("", "## How the work flows", "", `The customer's processes. \`openfde flows --engagement ${e}\` draws them.`, "");
  if (doc.workflows.length === 0) md.push("- None recorded yet.");
  md.push(
    ...capped(doc.workflows, 10, (n) => `- +${n} more: \`openfde flows --engagement ${e}\``, (w) => {
      const bits = [
        w.steps.length ? `steps: ${list(w.steps)}` : null,
        w.blockedBy.length ? `blocked by ${list(w.blockedBy)}` : null,
        w.automatedBy.length ? `automated by ${w.automatedBy.map((a) => `[[${a}]]`).join(", ")}` : null,
      ].filter(Boolean);
      return [`- **${w.name}**${w.summary ? ` — ${w.summary}` : ""}${bits.length ? ` · ${bits.join(" · ")}` : ""}`];
    }),
  );

  const vocab = [
    ...doc.workflows.map((w) => w.name),
    ...doc.workflows.flatMap((w) => w.steps),
    ...doc.dataSources.map((d) => d.name),
    ...doc.goals.map((g) => g.name),
  ];
  const seen = new Set<string>();
  const terms = vocab.filter((t) => (seen.has(t.toLowerCase()) ? false : (seen.add(t.toLowerCase()), true)));
  md.push("", "## Vocabulary", "", "Use these names exactly as the customer does; they are the keys `openfde recall` matches on.", "");
  md.push(terms.length === 0 ? "- None recorded yet." : `- ${terms.slice(0, 40).map((t) => `\`${t}\``).join(", ")}${terms.length > 40 ? `, +${terms.length - 40} more` : ""}`);

  md.push("", fdeProtocolMarkdown(e));

  md.push("", "## Notes from the FDE", "", "Hand-written by the engineer; treat as instructions.", "", FDE_CUSTOM_START, doc.custom ?? CUSTOM_PLACEHOLDER, FDE_CUSTOM_END, "");

  const pending = doc.totals.pendingEpisodes
    ? ` · **${doc.totals.pendingEpisodes} episode(s) not yet extracted — run \`openfde extract\` before trusting this brief as complete**`
    : "";
  md.push(
    "---",
    `<small>${doc.totals.entities} entities · ${doc.totals.facts} active facts · ${doc.totals.episodes} episodes${pending} · generated ${doc.generatedAt.slice(0, 19).replace("T", " ")} by openfde · spec ${FDE_SPEC_URL}</small>`,
  );
  return md.join("\n");
}
