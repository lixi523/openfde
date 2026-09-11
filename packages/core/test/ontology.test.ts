import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENTITY_SCHEMA,
  ENTITY_TYPES,
  RELATION_SCHEMA,
  RELATION_TYPES,
  describeOntology,
  relationFits,
} from "@openfde/ontology";
import { setupEnv, teardownEnv, type TestEnv } from "./helpers.js";
import {
  buildOntologyView,
  findPath,
  ingestEpisode,
  MockExtractor,
  ontologyMarkdown,
  ontologyRdf,
  pathMarkdown,
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
      "Person:Wang|OWNS|System:SAP :: Wang owns SAP",
      "Workflow:monthly-reconciliation|DEPENDS_ON|System:SAP :: Reconciliation depends on the SAP export",
      "WorkflowStep:csv-cleanup|PART_OF|Workflow:monthly-reconciliation :: CSV cleanup is a step of reconciliation",
      "Person:Chen|TRUSTS|DataSource:settlement-db :: Chen trusts the settlement DB",
      // a person cannot BLOCK a workflow: the schema says Constraint → Workflow|WorkflowStep|Goal
      "Person:Li|BLOCKS|Workflow:monthly-reconciliation :: Li keeps pushing back on the reconciliation rewrite",
    ].join("\n"),
    sourceUri: "interview://onsite",
  });
  await runExtraction(db(), new MockExtractor());
}

describe("ontology schema", () => {
  it("describes every entity and relation type and references only known types", () => {
    for (const type of ENTITY_TYPES) {
      expect(ENTITY_SCHEMA[type].description.length).toBeGreaterThan(10);
    }
    for (const rel of RELATION_TYPES) {
      const s = RELATION_SCHEMA[rel];
      expect(s.description.length).toBeGreaterThan(5);
      for (const t of [...s.domain, ...s.range]) expect(ENTITY_TYPES).toContain(t);
    }
    const prompt = describeOntology();
    expect(prompt).toContain("- TRUSTS: Person -> DataSource.");
    expect(prompt).toContain("- RELATES_TO: any -> any.");
  });

  it("checks domain and range, treating empty lists as any", () => {
    expect(relationFits("TRUSTS", "Person", "DataSource")).toBe(true);
    expect(relationFits("TRUSTS", "System", "DataSource")).toBe(false);
    expect(relationFits("TRUSTS", "Person", "System")).toBe(false);
    expect(relationFits("RATIONALE", "Decision", "Constraint")).toBe(true);
    expect(relationFits("RATIONALE", "Person", "Constraint")).toBe(false);
    expect(relationFits("RELATES_TO", "Asset", "Customer")).toBe(true);
    // unary facts only check the subject
    expect(relationFits("REPORTED", "Person", null)).toBe(true);
    expect(relationFits("REPORTED", "System", null)).toBe(false);
  });
});

describe("write-time coercion", () => {
  it("keeps a violating fact but downgrades its relation to RELATES_TO", async () => {
    await seed();
    const rows = db()
      .prepare(`SELECT predicate, statement FROM facts WHERE statement LIKE 'Li keeps%'`)
      .all() as { predicate: string; statement: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.predicate).toBe("RELATES_TO");
    // valid facts are untouched
    const trusts = db().prepare(`SELECT count(*) AS n FROM facts WHERE predicate = 'TRUSTS'`).get() as { n: number };
    expect(trusts.n).toBe(1);
  });

  it("reports the coercion in extraction stats", async () => {
    ingestEpisode(db(), {
      kind: "text",
      content: "System:SAP|TRUSTS|DataSource:settlement-db :: SAP trusts the settlement DB",
      sourceUri: "chat://x",
    });
    const stats = await runExtraction(db(), new MockExtractor());
    expect(stats.coerced).toBe(1);
    expect(stats.facts.ADD).toBe(1);
  });
});

describe("ontology view", () => {
  it("counts instances per type, orphans, density, and finds no violations after coercion", async () => {
    await seed();
    // an entity with no facts at all
    db()
      .prepare(`INSERT INTO entities (id, type, name, created_at) VALUES ('ent_orphan', 'Goal', 'close-books-fast', '2026-01-01')`)
      .run();
    const view = buildOntologyView(db());
    const person = view.entityTypes.find((t) => t.type === "Person")!;
    expect(person.count).toBe(3);
    expect(person.orphans).toBe(0);
    expect(view.entityTypes.find((t) => t.type === "Goal")!.orphans).toBe(1);
    expect(view.orphanNames).toEqual(["close-books-fast"]);
    expect(view.relationTypes.find((r) => r.type === "RELATES_TO")!.count).toBe(1);
    expect(view.relationTypes.find((r) => r.type === "PART_OF")!.domain).toEqual(["WorkflowStep"]);
    expect(view.totals.entities).toBe(8);
    expect(view.totals.facts).toBe(5);
    expect(view.violations).toEqual([]);
    expect(view.unknownTypes).toEqual([]);

    const md = ontologyMarkdown(view, "acme-corp");
    expect(md).toContain("| **Person** | actor | 3 | 0 |");
    expect(md).toContain("| TRUSTS | Person → DataSource | many-to-many | 1 |");
    expect(md).toContain("1 orphan entities");
    expect(md).toContain("[[close-books-fast]]");
  });

  it("surfaces violations recorded before coercion existed, with citations", async () => {
    await seed();
    db().prepare(`UPDATE facts SET predicate = 'BLOCKS' WHERE statement LIKE 'Li keeps%'`).run();
    const view = buildOntologyView(db());
    expect(view.violations).toHaveLength(1);
    expect(view.violations[0]).toMatchObject({
      predicate: "BLOCKS",
      subject: "Li",
      subjectType: "Person",
      object: "monthly-reconciliation",
      sourceUri: "interview://onsite",
    });
    expect(ontologyMarkdown(view, "acme-corp")).toContain("1 schema violations");
  });

  it("renders the schema even for an empty engagement", () => {
    const md = ontologyMarkdown(buildOntologyView(db()), "acme-corp");
    expect(md).toContain("| **Goal** | plane | 0 | 0 |");
    expect(md).toContain("No instances yet");
  });
});

describe("RDF/OWL export", () => {
  it("emits classes, object properties with domain/range, individuals, and reified facts with provenance", async () => {
    await seed();
    const rdf = ontologyRdf(db(), "acme-corp");
    expect(rdf).toContain('<owl:Class rdf:about="urn:openfde:ontology#Workflow">');
    expect(rdf).toContain('<owl:ObjectProperty rdf:about="urn:openfde:ontology#TRUSTS">');
    expect(rdf).toContain('<rdfs:domain rdf:resource="urn:openfde:ontology#Person"/>');
    expect(rdf).toContain('<rdfs:range rdf:resource="urn:openfde:ontology#DataSource"/>');
    // unions become annotations rather than intersecting rdfs:domain triples
    expect(rdf).toContain("<ont:rangeTypes>System,DataSource,Workflow,WorkflowStep</ont:rangeTypes>");
    expect(rdf).toMatch(/<ont:Person rdf:about="urn:openfde:engagement:acme-corp#ent_[a-f0-9]+">/);
    expect(rdf).toContain("<rdfs:label>Wang</rdfs:label>");
    expect(rdf).toMatch(/<ont:OWNS rdf:resource="urn:openfde:engagement:acme-corp#ent_[a-f0-9]+"\/>/);
    expect(rdf).toContain('<rdf:predicate rdf:resource="urn:openfde:ontology#DEPENDS_ON"/>');
    expect(rdf).toContain("<ont:source>interview://onsite</ont:source>");
    expect(rdf).toContain("<ont:quote>Person:Wang|OWNS|System:SAP :: Wang owns SAP</ont:quote>");
  });

  it("escapes XML and honours schema-only", async () => {
    ingestEpisode(db(), {
      kind: "text",
      content: 'Person:O&Reilly|TRUSTS|DataSource:sales<2026> :: "Quotes" & <angles>',
      sourceUri: "chat://x",
    });
    await runExtraction(db(), new MockExtractor());
    const rdf = ontologyRdf(db(), "acme-corp");
    expect(rdf).toContain("<rdfs:label>O&amp;Reilly</rdfs:label>");
    expect(rdf).toContain("<rdfs:label>sales&lt;2026&gt;</rdfs:label>");
    expect(rdf).toContain("&quot;Quotes&quot; &amp; &lt;angles&gt;");
    expect(rdf).not.toContain("<2026>");

    const schema = ontologyRdf(db(), "acme-corp", { schemaOnly: true });
    expect(schema).toContain("<owl:Class");
    expect(schema).not.toContain("rdf:Statement");
    expect(schema).not.toContain("O&amp;Reilly");
  });

  it("carries supersession into the export", async () => {
    ingestEpisode(db(), { kind: "text", content: "Person:Wang|TRUSTS|DataSource:db :: Wang trusts db v1", sourceUri: "a" });
    await runExtraction(db(), new MockExtractor());
    ingestEpisode(db(), { kind: "text", content: "Person:Wang|TRUSTS|DataSource:db :: Wang trusts db v2", sourceUri: "b" });
    await runExtraction(db(), new MockExtractor());
    const rdf = ontologyRdf(db(), "acme-corp");
    expect(rdf).toMatch(/<ont:supersededBy rdf:resource="urn:openfde:engagement:acme-corp#fact_[a-f0-9]+"\/>/);
    expect(rdf).toContain("<ont:expiredAt>");
    // only the active fact is a direct link on the individual
    expect(rdf.match(/<ont:TRUSTS rdf:resource=/g)).toHaveLength(1);
  });
});

describe("path finding", () => {
  it("finds the shortest cited chain in either direction and is case-insensitive", async () => {
    await seed();
    const result = findPath(db(), "wang", "csv-cleanup");
    expect(result).not.toBeNull();
    expect(result!.hops.map((h) => `${h.from} ${h.direction === "forward" ? "-" : "<"}${h.predicate}${h.direction === "forward" ? ">" : "-"} ${h.to}`)).toEqual([
      "Wang -OWNS> SAP",
      "SAP <DEPENDS_ON- monthly-reconciliation",
      "monthly-reconciliation <PART_OF- csv-cleanup",
    ]);
    expect(result!.hops.every((h) => h.sourceUri === "interview://onsite")).toBe(true);
    const md = pathMarkdown(result, "wang", "csv-cleanup");
    expect(md).toContain("3 hops");
    expect(md).toContain("[[Wang]] (Person) —OWNS→ [[SAP]] (System)");
    expect(md).toContain("←DEPENDS_ON—");
  });

  it("returns null for unknown or disconnected entities, and an empty path for the same entity", async () => {
    await seed();
    expect(findPath(db(), "Wang", "nobody")).toBeNull();
    // Chen/settlement-db form their own component
    expect(findPath(db(), "Wang", "Chen")).toBeNull();
    expect(pathMarkdown(null, "Wang", "Chen")).toContain("No chain of active facts");
    expect(findPath(db(), "Wang", "WANG")!.hops).toEqual([]);
  });

  it("ignores superseded facts", async () => {
    ingestEpisode(db(), { kind: "text", content: "Person:Wang|OWNS|System:SAP :: v1", sourceUri: "a" });
    await runExtraction(db(), new MockExtractor());
    // supersede with a fact that still links the same pair: path must use the active one
    ingestEpisode(db(), { kind: "text", content: "Person:Wang|OWNS|System:SAP :: v2", sourceUri: "b" });
    await runExtraction(db(), new MockExtractor());
    const result = findPath(db(), "Wang", "SAP")!;
    expect(result.hops).toHaveLength(1);
    expect(result.hops[0]!.statement).toBe("v2");
    expect(result.hops[0]!.sourceUri).toBe("b");
  });
});
