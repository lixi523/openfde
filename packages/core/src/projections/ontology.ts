import {
  ENTITY_SCHEMA,
  ENTITY_TYPES,
  ONTOLOGY_NAME,
  ONTOLOGY_VERSION,
  RELATION_SCHEMA,
  RELATION_TYPES,
  relationFits,
  type EntityType,
  type RelationType,
} from "@openfde/ontology";
import type { Ledger } from "../ledger/database.js";
import { resolveEntityByName } from "./notes.js";

/**
 * The ontology as a first-class, inspectable artifact.
 *
 * Three projections share this file:
 * - the schema view: what each type means, how populated it is, and where the
 *   graph is unhealthy (orphans, domain/range violations) — the ontology's own
 *   dashboard rather than a legend hidden in the graph tab;
 * - RDF/XML (OWL) export: classes, object properties with domain/range, and,
 *   unless schema-only, every entity as an individual and every fact as a
 *   reified statement carrying its provenance — so the engagement graph can be
 *   loaded into Protégé, Fabric IQ, or any triple store;
 * - path finding: the shortest chain of cited facts connecting two entities
 *   ("how does the CFO relate to the reconciliation workflow?").
 *
 * All three are deterministic ledger reads; no LLM.
 */

export interface EntityTypeStat {
  type: EntityType;
  layer: string;
  description: string;
  /** Active entities of this type */
  count: number;
  /** Active entities of this type with no active fact at all */
  orphans: number;
}

export interface RelationTypeStat {
  type: RelationType;
  description: string;
  domain: string[];
  range: string[];
  cardinality: string;
  /** Active facts using this predicate */
  count: number;
}

export interface SchemaViolation {
  factId: string;
  predicate: string;
  subject: string;
  subjectType: string;
  object: string | null;
  objectType: string | null;
  statement: string;
  sourceUri: string;
}

export interface OntologyView {
  name: string;
  version: string;
  entityTypes: EntityTypeStat[];
  relationTypes: RelationTypeStat[];
  totals: {
    entities: number;
    facts: number;
    /** Active facts per active entity; the authoring heuristic is 1–2 */
    density: number;
    orphans: number;
  };
  /** Names of active entities with no active fact, for the health section */
  orphanNames: string[];
  /** Active facts whose predicate does not fit its subject/object types */
  violations: SchemaViolation[];
  /** Entity or relation types present in the ledger but absent from the ontology */
  unknownTypes: string[];
}

interface EntityRow {
  id: string;
  type: string;
  name: string;
  summary: string | null;
  trust: string | null;
}

interface FactRow {
  id: string;
  predicate: string;
  subject_id: string;
  object_id: string | null;
  statement: string;
  quote: string | null;
  source_uri: string;
  created_at: string;
  expired_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  invalidated_by: string | null;
}

function activeEntities(db: Ledger): EntityRow[] {
  return db
    .prepare(
      `SELECT id, type, name, summary, trust FROM entities WHERE expired_at IS NULL ORDER BY type, name`,
    )
    .all() as EntityRow[];
}

function facts(db: Ledger, includeExpired: boolean): FactRow[] {
  return db
    .prepare(
      `SELECT f.id, f.predicate, f.subject_id, f.object_id, f.statement, f.quote,
              e.source_uri, f.created_at, f.expired_at, f.valid_from, f.valid_until, f.invalidated_by
       FROM facts f JOIN episodes e ON e.id = f.episode_id
       ${includeExpired ? "" : "WHERE f.expired_at IS NULL"}
       ORDER BY f.created_at`,
    )
    .all() as FactRow[];
}

export function buildOntologyView(db: Ledger): OntologyView {
  const entities = activeEntities(db);
  const active = facts(db, false);
  const byId = new Map(entities.map((e) => [e.id, e]));

  const involved = new Set<string>();
  for (const f of active) {
    involved.add(f.subject_id);
    if (f.object_id) involved.add(f.object_id);
  }

  const entityTypes: EntityTypeStat[] = ENTITY_TYPES.map((type) => {
    const ofType = entities.filter((e) => e.type === type);
    return {
      type,
      layer: ENTITY_SCHEMA[type].layer,
      description: ENTITY_SCHEMA[type].description,
      count: ofType.length,
      orphans: ofType.filter((e) => !involved.has(e.id)).length,
    };
  });

  const relationTypes: RelationTypeStat[] = RELATION_TYPES.map((type) => ({
    type,
    description: RELATION_SCHEMA[type].description,
    domain: [...RELATION_SCHEMA[type].domain],
    range: [...RELATION_SCHEMA[type].range],
    cardinality: RELATION_SCHEMA[type].cardinality,
    count: active.filter((f) => f.predicate === type).length,
  }));

  const knownEntityTypes = new Set<string>(ENTITY_TYPES);
  const knownRelationTypes = new Set<string>(RELATION_TYPES);
  const unknownTypes = new Set<string>();
  for (const e of entities) if (!knownEntityTypes.has(e.type)) unknownTypes.add(e.type);
  for (const f of active) if (!knownRelationTypes.has(f.predicate)) unknownTypes.add(f.predicate);

  const violations: SchemaViolation[] = [];
  for (const f of active) {
    const subject = byId.get(f.subject_id);
    if (!subject || !knownEntityTypes.has(subject.type) || !knownRelationTypes.has(f.predicate)) {
      continue;
    }
    const object = f.object_id ? byId.get(f.object_id) : undefined;
    const objectType = object ? (object.type as EntityType) : null;
    if (object && !knownEntityTypes.has(object.type)) continue;
    if (relationFits(f.predicate as RelationType, subject.type as EntityType, objectType)) continue;
    violations.push({
      factId: f.id,
      predicate: f.predicate,
      subject: subject.name,
      subjectType: subject.type,
      object: object?.name ?? null,
      objectType: object?.type ?? null,
      statement: f.statement,
      sourceUri: f.source_uri,
    });
  }

  const orphanNames = entities.filter((e) => !involved.has(e.id)).map((e) => e.name);
  return {
    name: ONTOLOGY_NAME,
    version: ONTOLOGY_VERSION,
    entityTypes,
    relationTypes,
    totals: {
      entities: entities.length,
      facts: active.length,
      density: entities.length === 0 ? 0 : Math.round((active.length / entities.length) * 100) / 100,
      orphans: orphanNames.length,
    },
    orphanNames,
    violations,
    unknownTypes: [...unknownTypes].sort(),
  };
}

const arrow = (types: string[]): string => (types.length ? types.join(" \\| ") : "any");

export function ontologyMarkdown(view: OntologyView, engagement: string): string {
  const md = [
    `# Ontology — ${engagement}`,
    "",
    `${view.name} v${view.version} · ${view.entityTypes.length} entity types · ${view.relationTypes.length} relation types · ` +
      `${view.totals.entities} entities · ${view.totals.facts} active facts · ${view.totals.density} facts per entity`,
    "",
    "The fixed vocabulary every extraction is constrained to. Counts are live; the schema itself lives in `packages/ontology`.",
    "",
    "## Entity types",
    "",
    "| Type | Layer | Instances | Orphans | Meaning |",
    "| --- | --- | ---: | ---: | --- |",
  ];
  for (const t of view.entityTypes) {
    md.push(`| **${t.type}** | ${t.layer} | ${t.count} | ${t.orphans} | ${t.description} |`);
  }
  md.push(
    "",
    "## Relation types",
    "",
    "| Relation | Subject → Object | Cardinality | Facts | Meaning |",
    "| --- | --- | --- | ---: | --- |",
  );
  for (const r of view.relationTypes) {
    md.push(
      `| ${r.type} | ${arrow(r.domain)} → ${arrow(r.range)} | ${r.cardinality} | ${r.count} | ${r.description} |`,
    );
  }

  md.push("", "## Health", "");
  if (view.totals.entities === 0) {
    md.push("_No instances yet. Ingest interviews and run `openfde extract`; the schema above is what extraction will fill._");
  } else {
    const density = view.totals.density;
    md.push(
      density < 1
        ? `- **Sparse graph** — ${density} facts per entity; below 1 most entities are mentioned once and never connected. Interview for relationships (owners, dependencies, blockers).`
        : `- **Density ${density}** facts per entity (1–2 is a well-connected engagement graph).`,
    );
    md.push(
      view.orphanNames.length === 0
        ? "- **No orphan entities** — every entity takes part in at least one fact."
        : `- **${view.orphanNames.length} orphan entities** with no fact at all: ${view.orphanNames
            .slice(0, 20)
            .map((n) => `[[${n}]]`)
            .join(", ")}${view.orphanNames.length > 20 ? ", …" : ""}. Orphans cannot be recalled by graph expansion; connect or retire them.`,
    );
    if (view.violations.length === 0) {
      md.push("- **No schema violations** — every active fact honours its relation's domain and range.");
    } else {
      md.push(
        `- **${view.violations.length} schema violations** — facts whose relation does not fit the types it connects (recorded before write-time coercion, or via a legacy path):`,
        "",
        "| Fact | Types | Statement | Source |",
        "| --- | --- | --- | --- |",
      );
      for (const v of view.violations) {
        const types = v.objectType ? `${v.subjectType} → ${v.objectType}` : v.subjectType;
        md.push(
          `| ${v.subject} —${v.predicate}→ ${v.object ?? "∅"} | ${types} | ${v.statement.replace(/\|/g, "\\|")} | ${v.sourceUri} |`,
        );
      }
    }
    if (view.unknownTypes.length > 0) {
      md.push(`- **Unknown types in ledger**: ${view.unknownTypes.join(", ")} — not part of the ontology; migrate or retire.`);
    }
  }
  md.push("", "<small>Export the graph as RDF/OWL with `openfde ontology --rdf` · trace a chain of facts with `openfde path <a> <b>`</small>");
  return md.join("\n");
}

/* ---------------- RDF/XML (OWL) ---------------- */

const ONT_NS = "urn:openfde:ontology#";

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function literal(tag: string, value: string | null | undefined): string {
  return value == null || value === "" ? "" : `        <${tag}>${escapeXml(value)}</${tag}>\n`;
}

export interface RdfOptions {
  /** Emit classes and properties only; no individuals or statements */
  schemaOnly?: boolean;
}

/**
 * RDF/XML with OWL vocabulary. Schema: one owl:Class per entity type, one
 * owl:ObjectProperty per relation (rdfs:domain/range when unambiguous, listed
 * as annotations otherwise). Instances: each entity is an individual typed by
 * its class; each fact is both a direct object-property link on the subject
 * (for graph tools) and a reified rdf:Statement carrying statement, quote,
 * source, validity, and supersession — provenance survives the export.
 */
export function ontologyRdf(db: Ledger, engagement: string, options: RdfOptions = {}): string {
  const engNs = `urn:openfde:engagement:${engagement}#`;
  let rdf = '<?xml version="1.0" encoding="UTF-8"?>\n';
  rdf += "<rdf:RDF\n";
  rdf += '    xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"\n';
  rdf += '    xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"\n';
  rdf += '    xmlns:owl="http://www.w3.org/2002/07/owl#"\n';
  rdf += '    xmlns:xsd="http://www.w3.org/2001/XMLSchema#"\n';
  rdf += `    xmlns:ont="${ONT_NS}"\n`;
  rdf += `    xmlns:eng="${engNs}">\n\n`;

  rdf += `    <owl:Ontology rdf:about="${ONT_NS.slice(0, -1)}">\n`;
  rdf += literal("rdfs:label", ONTOLOGY_NAME);
  rdf += literal("owl:versionInfo", ONTOLOGY_VERSION);
  rdf += literal(
    "rdfs:comment",
    "Engagement ontology of OpenFDE: goals, workflows, decisions, constraints, data sources and pain points, with every fact traceable to its source.",
  );
  rdf += "    </owl:Ontology>\n\n";

  rdf += "    <!-- Entity types (classes) -->\n";
  for (const type of ENTITY_TYPES) {
    const s = ENTITY_SCHEMA[type];
    rdf += `    <owl:Class rdf:about="${ONT_NS}${type}">\n`;
    rdf += literal("rdfs:label", type);
    rdf += literal("rdfs:comment", s.description);
    rdf += literal("ont:layer", s.layer);
    rdf += "    </owl:Class>\n";
  }

  rdf += "\n    <!-- Data properties shared by all classes -->\n";
  for (const [name, comment, domain] of [
    ["summary", "One sentence describing the entity in the customer organization", null],
    ["trust", "trusted | contested | distrusted | unknown", "DataSource"],
  ] as const) {
    rdf += `    <owl:DatatypeProperty rdf:about="${ONT_NS}${name}">\n`;
    rdf += literal("rdfs:label", name);
    rdf += literal("rdfs:comment", comment);
    if (domain) rdf += `        <rdfs:domain rdf:resource="${ONT_NS}${domain}"/>\n`;
    rdf += '        <rdfs:range rdf:resource="http://www.w3.org/2001/XMLSchema#string"/>\n';
    rdf += "    </owl:DatatypeProperty>\n";
  }

  rdf += "\n    <!-- Relation types (object properties) -->\n";
  for (const rel of RELATION_TYPES) {
    const s = RELATION_SCHEMA[rel];
    rdf += `    <owl:ObjectProperty rdf:about="${ONT_NS}${rel}">\n`;
    rdf += literal("rdfs:label", rel);
    rdf += literal("rdfs:comment", s.description);
    // OWL treats several rdfs:domain triples as an intersection, so a single
    // type is emitted as a proper domain/range and a union goes to annotations.
    if (s.domain.length === 1) rdf += `        <rdfs:domain rdf:resource="${ONT_NS}${s.domain[0]}"/>\n`;
    else if (s.domain.length > 1) rdf += literal("ont:domainTypes", s.domain.join(","));
    if (s.range.length === 1) rdf += `        <rdfs:range rdf:resource="${ONT_NS}${s.range[0]}"/>\n`;
    else if (s.range.length > 1) rdf += literal("ont:rangeTypes", s.range.join(","));
    rdf += literal("ont:cardinality", s.cardinality);
    rdf += "    </owl:ObjectProperty>\n";
  }

  if (!options.schemaOnly) {
    const entities = activeEntities(db);
    const all = facts(db, true);
    const byId = new Map(entities.map((e) => [e.id, e]));

    rdf += `\n    <!-- Individuals: engagement "${escapeXml(engagement)}" -->\n`;
    for (const e of entities) {
      const tag = ENTITY_TYPES.includes(e.type as EntityType) ? `ont:${e.type}` : "owl:NamedIndividual";
      rdf += `    <${tag} rdf:about="${engNs}${e.id}">\n`;
      rdf += literal("rdfs:label", e.name);
      rdf += literal("ont:summary", e.summary);
      rdf += literal("ont:trust", e.trust);
      for (const f of all) {
        if (f.subject_id !== e.id || !f.object_id || f.expired_at) continue;
        if (!byId.has(f.object_id)) continue;
        rdf += `        <ont:${f.predicate} rdf:resource="${engNs}${f.object_id}"/>\n`;
      }
      rdf += `    </${tag}>\n`;
    }

    rdf += "\n    <!-- Facts as reified statements: provenance, validity, supersession -->\n";
    for (const f of all) {
      if (!byId.has(f.subject_id)) continue;
      rdf += `    <rdf:Statement rdf:about="${engNs}${f.id}">\n`;
      rdf += `        <rdf:subject rdf:resource="${engNs}${f.subject_id}"/>\n`;
      rdf += `        <rdf:predicate rdf:resource="${ONT_NS}${f.predicate}"/>\n`;
      if (f.object_id && byId.has(f.object_id)) {
        rdf += `        <rdf:object rdf:resource="${engNs}${f.object_id}"/>\n`;
      }
      rdf += literal("ont:statement", f.statement);
      rdf += literal("ont:quote", f.quote);
      rdf += literal("ont:source", f.source_uri);
      rdf += literal("ont:recordedAt", f.created_at);
      rdf += literal("ont:validFrom", f.valid_from);
      rdf += literal("ont:validUntil", f.valid_until);
      rdf += literal("ont:expiredAt", f.expired_at);
      if (f.invalidated_by) {
        rdf += `        <ont:supersededBy rdf:resource="${engNs}${f.invalidated_by}"/>\n`;
      }
      rdf += "    </rdf:Statement>\n";
    }
  }

  rdf += "</rdf:RDF>\n";
  return rdf;
}

/* ---------------- path finding ---------------- */

export interface PathHop {
  from: string;
  fromType: string;
  to: string;
  toType: string;
  predicate: string;
  /** "forward" when the fact reads from→to; "reverse" when it was recorded to→from */
  direction: "forward" | "reverse";
  statement: string;
  sourceUri: string;
}

export interface PathResult {
  from: string;
  to: string;
  hops: PathHop[];
}

/**
 * Shortest chain of active facts between two entities (by name), traversing
 * relations in either direction. Returns null when either entity is unknown
 * or no chain exists; every hop is a cited fact.
 */
export function findPath(db: Ledger, fromName: string, toName: string): PathResult | null {
  const fromId = resolveEntityByName(db, fromName);
  const toId = resolveEntityByName(db, toName);
  if (!fromId || !toId) return null;
  const entities = new Map(activeEntities(db).map((e) => [e.id, e]));
  const from = entities.get(fromId);
  const to = entities.get(toId);
  if (!from || !to) return null;
  if (fromId === toId) return { from: from.name, to: to.name, hops: [] };

  const adjacency = new Map<string, { next: string; fact: FactRow; direction: PathHop["direction"] }[]>();
  for (const f of facts(db, false)) {
    if (!f.object_id || !entities.has(f.subject_id) || !entities.has(f.object_id)) continue;
    if (!adjacency.has(f.subject_id)) adjacency.set(f.subject_id, []);
    if (!adjacency.has(f.object_id)) adjacency.set(f.object_id, []);
    adjacency.get(f.subject_id)!.push({ next: f.object_id, fact: f, direction: "forward" });
    adjacency.get(f.object_id)!.push({ next: f.subject_id, fact: f, direction: "reverse" });
  }

  const previous = new Map<string, { via: FactRow; direction: PathHop["direction"]; prev: string }>();
  const visited = new Set([fromId]);
  const queue = [fromId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of adjacency.get(current) ?? []) {
      if (visited.has(edge.next)) continue;
      visited.add(edge.next);
      previous.set(edge.next, { via: edge.fact, direction: edge.direction, prev: current });
      if (edge.next === toId) {
        const hops: PathHop[] = [];
        let cursor = toId;
        while (cursor !== fromId) {
          const step = previous.get(cursor)!;
          const a = entities.get(step.prev)!;
          const b = entities.get(cursor)!;
          hops.unshift({
            from: a.name,
            fromType: a.type,
            to: b.name,
            toType: b.type,
            predicate: step.via.predicate,
            direction: step.direction,
            statement: step.via.statement,
            sourceUri: step.via.source_uri,
          });
          cursor = step.prev;
        }
        return { from: from.name, to: to.name, hops };
      }
      queue.push(edge.next);
    }
  }
  return null;
}

export function pathMarkdown(result: PathResult | null, fromName: string, toName: string): string {
  const md = [`# Path — ${fromName} → ${toName}`, ""];
  if (!result) {
    md.push(
      `_No chain of active facts connects **${fromName}** and **${toName}** (or one of them is not in the graph). Check names with \`openfde recall\`, or interview for the missing link._`,
    );
    return md.join("\n");
  }
  if (result.hops.length === 0) {
    md.push(`_**${result.from}** and **${result.to}** are the same entity._`);
    return md.join("\n");
  }
  md.push(`${result.hops.length} hop${result.hops.length === 1 ? "" : "s"}, every hop a recorded fact:`, "");
  result.hops.forEach((hop, i) => {
    const edge = hop.direction === "forward" ? `—${hop.predicate}→` : `←${hop.predicate}—`;
    md.push(
      `${i + 1}. [[${hop.from}]] (${hop.fromType}) ${edge} [[${hop.to}]] (${hop.toType})`,
      `   ${hop.statement}`,
      `   <small>${hop.sourceUri}</small>`,
    );
  });
  return md.join("\n");
}
