import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupEnv, teardownEnv, type TestEnv } from "./helpers.js";
import {
  buildFdeDoc,
  buildRunPrompt,
  extractCustomBlock,
  fdeMarkdown,
  fdeProtocolMarkdown,
  ingestEpisode,
  MockExtractor,
  runExtraction,
} from "../src/index.js";

let env: TestEnv;
beforeEach(() => { env = setupEnv(); });
afterEach(() => { teardownEnv(env); });
const db = () => env.db;

async function seed(): Promise<void> {
  ingestEpisode(db(), {
    kind: "message",
    content: [
      "Workflow:monthly-reconciliation|SUPPORTS|Goal:close-books-in-2-days :: Finance wants the monthly close to finish within two days",
      "WorkflowStep:csv-cleanup|PART_OF|Workflow:monthly-reconciliation :: Someone cleans the CSV by hand every month",
      "Constraint:no-direct-prod-access|BLOCKS|Workflow:monthly-reconciliation :: Security forbids direct production database access",
      "Person:Li|OWNS|DataSource:MES-settlement-db :: Li owns the MES settlement database",
      "Person:Wang|TRUSTS|DataSource:MES-settlement-db :: Wang trusts the MES settlement database",
      "Decision:use-SAP-export|RATIONALE|Constraint:no-direct-prod-access :: We decided to use the SAP export instead of a direct DB link",
      "Decision:use-SAP-export|DECIDED_BY|Person:Wang :: Wang made the call",
      "Asset:reconciliation-agent|AUTOMATES|WorkflowStep:csv-cleanup :: The agent automates the CSV cleanup",
      "Customer:Acme Manufacturing|RELATES_TO|Goal:close-books-in-2-days :: Acme is the customer",
    ].join("\n"),
    sourceUri: "interview://onsite",
    speaker: "Wang",
  });
  await runExtraction(db(), new MockExtractor());
}

describe("FDE.md", () => {
  it("projects the engagement into the brief's sections, cited", async () => {
    await seed();
    const doc = buildFdeDoc(db(), "acme-corp");
    expect(doc.customers.map((c) => c.name)).toEqual(["Acme Manufacturing"]);
    expect(doc.goals[0]).toMatchObject({ name: "close-books-in-2-days", supportedBy: ["monthly-reconciliation"] });
    expect(doc.goals[0]!.evidence[0]).toMatchObject({ sourceUri: "interview://onsite", speaker: "Wang" });
    expect(doc.constraints[0]).toMatchObject({ name: "no-direct-prod-access", blocks: ["monthly-reconciliation"] });
    expect(doc.dataSources[0]).toMatchObject({ name: "MES-settlement-db", owners: ["Li"], trustedBy: ["Wang"] });
    expect(doc.people.find((p) => p.name === "Wang")).toMatchObject({ trusts: ["MES-settlement-db"], decides: ["use-SAP-export"] });
    expect(doc.decisions[0]).toMatchObject({ name: "use-SAP-export", decidedBy: ["Wang"], rationale: ["no-direct-prod-access"] });
    expect(doc.workflows[0]).toMatchObject({
      name: "monthly-reconciliation",
      steps: ["csv-cleanup"],
      blockedBy: ["no-direct-prod-access"],
      automatedBy: ["reconciliation-agent (csv-cleanup)"],
    });
    expect(doc.totals.facts).toBe(9);

    const md = fdeMarkdown(doc);
    expect(md.startsWith("---\nfde: 1\nengagement: acme-corp\n")).toBe(true);
    expect(md).toContain("# FDE.md — acme-corp");
    for (const h of ["## Who we serve", "## Mission", "## Never violate", "## Ground truth", "## People", "## Decisions already made", "## How the work flows", "## Memory", "## Work", "## When the runner spawned you", "## Notes from the FDE"]) {
      expect(md).toContain(h);
    }
    expect(md.indexOf("## Never violate")).toBeLessThan(md.indexOf("## Memory"));
    expect(md).toContain("> Security forbids direct production database access");
    expect(md).toContain("<small>interview://onsite · Wang</small>");
    expect(md).toContain("- **MES-settlement-db**");
    expect(md).toContain("owned by [[Li]] · trusted by [[Wang]]");
    expect(md).toContain("<!-- fde:custom -->");
    expect(md).toContain("spec: https://fde.md");
  });

  it("names its gaps instead of hiding them, and flags unextracted material", () => {
    ingestEpisode(db(), { kind: "text", content: "raw notes", sourceUri: "chat://x" });
    const md = fdeMarkdown(buildFdeDoc(db(), "acme-corp"));
    expect(md).toContain("No Customer entity recorded yet");
    expect(md).toContain("## Before anything");
    expect(md).toContain("## Vocabulary");
    expect(md).toContain("None recorded yet. Ask about security");
    expect(md).toContain("1 episode(s) not yet extracted");
  });

  it("keeps the FDE's custom block across regeneration", async () => {
    await seed();
    const first = fdeMarkdown(buildFdeDoc(db(), "acme-corp"));
    expect(extractCustomBlock(first)).toBeNull(); // placeholder does not count
    const edited = first.replace(/<!-- fde:custom -->[\s\S]*?<!-- \/fde:custom -->/, "<!-- fde:custom -->\nNever touch the SAP job schedule without Li.\n<!-- /fde:custom -->");
    const custom = extractCustomBlock(edited);
    expect(custom).toBe("Never touch the SAP job schedule without Li.");
    const second = fdeMarkdown(buildFdeDoc(db(), "acme-corp", { custom }));
    expect(second).toContain("Never touch the SAP job schedule without Li.");
    expect(second).not.toContain("_None yet.");
    expect(extractCustomBlock("no markers here")).toBeNull();
  });

  it("is the rulebook the runner hands to spawned agents", async () => {
    await seed();
    const protocol = fdeProtocolMarkdown();
    expect(protocol).toContain("Constraints outrank the task wording");
    expect(protocol).toContain("`DONE: ");
    expect(protocol).toContain("`BLOCKED: ");
    expect(protocol).toContain("`NEEDS_HUMAN: ");
    expect(protocol).toContain("NEVER open an interactive question");
    expect(fdeProtocolMarkdown("acme-corp")).toContain("--engagement acme-corp");

    const brief = fdeMarkdown(buildFdeDoc(db(), "acme-corp"));
    const prompt = buildRunPrompt({
      engagement: "acme-corp",
      runId: "run_1",
      branch: "openfde/x",
      cwd: "/wt",
      executorName: "claude-code",
      contextMarkdown: "# Task context: Do it",
      brief,
    });
    expect(prompt).toContain("## Never violate");
    expect(prompt).toContain("no-direct-prod-access");
    expect(prompt).toContain("# Task context: Do it");
    expect(prompt.indexOf("## Never violate")).toBeLessThan(prompt.indexOf("# Task context"));
  });
});
