import { ENTITY_TYPES, type EntityType } from "./entities.js";
import { RELATION_TYPES, type RelationType } from "./relations.js";

/**
 * The self-describing layer of the ontology.
 *
 * entities.ts / relations.ts say WHICH types exist; this file says what each
 * type MEANS and which subject/object types a relation may connect. Everything
 * that needs to explain or validate the ontology — the extraction prompt,
 * write-path coercion, the schema view, RDF/OWL export — reads it from here,
 * so the ontology stays a single artifact rather than an enum plus comments.
 */

export const ONTOLOGY_NAME = "OpenFDE engagement ontology";
export const ONTOLOGY_VERSION = "0.1";

/** Where a type sits in the dot-line-plane lens (plane = value, line = flow, point = detail) */
export const LAYERS = [
  "plane",
  "line",
  "point",
  "actor",
  "infrastructure",
  "governance",
  "asset",
] as const;
export type Layer = (typeof LAYERS)[number];

export interface EntityTypeSchema {
  description: string;
  layer: Layer;
}

export type Cardinality = "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";

export interface RelationTypeSchema {
  description: string;
  /** Allowed subject types; empty means any */
  domain: readonly EntityType[];
  /** Allowed object types; empty means any */
  range: readonly EntityType[];
  cardinality: Cardinality;
}

export const ENTITY_SCHEMA: Record<EntityType, EntityTypeSchema> = {
  Customer: {
    description: "The customer organization the engagement serves.",
    layer: "actor",
  },
  Goal: {
    description:
      "A value outcome the organization is trying to achieve; the plane leadership thinks in.",
    layer: "plane",
  },
  Person: {
    description:
      "A named stakeholder: owner of a system, decision maker, reporter of a pain, holder of trust.",
    layer: "actor",
  },
  System: {
    description: "A software system or application the organization runs.",
    layer: "infrastructure",
  },
  DataSource: {
    description:
      "A dataset, database, report or feed; carries a trust level recording who actually believes it.",
    layer: "infrastructure",
  },
  Workflow: {
    description: "A business process; the line that connects goals to daily work.",
    layer: "line",
  },
  WorkflowStep: {
    description: "One step of a workflow; the unit that gets automated or blocked.",
    layer: "point",
  },
  Decision: {
    description: "A choice that was made, together with who made it and why.",
    layer: "point",
  },
  Constraint: {
    description:
      "A rule that limits what can be built or changed: security, compliance, budget, politics.",
    layer: "governance",
  },
  PainPoint: {
    description:
      "Something that hurts today, reported by a person; the raw material of automation opportunities.",
    layer: "point",
  },
  Asset: {
    description:
      "A reusable deliverable (agent, script, prompt, rubric, playbook) that automates or supports work.",
    layer: "asset",
  },
};

export const RELATION_SCHEMA: Record<RelationType, RelationTypeSchema> = {
  SUPPORTS: {
    description: "Which value a flow or asset delivers.",
    domain: ["Workflow", "Asset", "WorkflowStep"],
    range: ["Goal"],
    cardinality: "many-to-many",
  },
  OWNS: {
    description: "Who is accountable for a system, data source or process.",
    domain: ["Person", "Customer"],
    range: ["System", "DataSource", "Workflow", "WorkflowStep"],
    cardinality: "many-to-many",
  },
  TRUSTS: {
    description: "Which data a person actually believes.",
    domain: ["Person"],
    range: ["DataSource"],
    cardinality: "many-to-many",
  },
  DEPENDS_ON: {
    description: "What a process or step needs in order to run.",
    domain: ["Workflow", "WorkflowStep"],
    range: ["System", "DataSource", "Workflow", "WorkflowStep"],
    cardinality: "many-to-many",
  },
  PART_OF: {
    description: "A step belongs to a workflow.",
    domain: ["WorkflowStep"],
    range: ["Workflow"],
    cardinality: "many-to-one",
  },
  DECIDED_BY: {
    description: "Who made a decision.",
    domain: ["Decision"],
    range: ["Person"],
    cardinality: "many-to-many",
  },
  RATIONALE: {
    description: "What a decision was based on.",
    domain: ["Decision"],
    range: [],
    cardinality: "many-to-many",
  },
  AUTOMATES: {
    description: "An asset already performs a step or process.",
    domain: ["Asset"],
    range: ["WorkflowStep", "Workflow"],
    cardinality: "many-to-many",
  },
  DERIVED_FROM: {
    description: "Where an asset came from (desensitization audit trail).",
    domain: ["Asset"],
    range: [],
    cardinality: "many-to-many",
  },
  BLOCKS: {
    description: "A constraint stops or limits a process, step or goal.",
    domain: ["Constraint"],
    range: ["Workflow", "WorkflowStep", "Goal"],
    cardinality: "many-to-many",
  },
  REPORTED: {
    description: "Who raised a pain point.",
    domain: ["Person", "Customer"],
    range: ["PainPoint"],
    cardinality: "many-to-many",
  },
  RELATES_TO: {
    description: "Fallback when no specific relation fits; prefer a specific type.",
    domain: [],
    range: [],
    cardinality: "many-to-many",
  },
};

/** Does a triple honour the relation's domain and range? Unary facts (no object) only check the domain. */
export function relationFits(
  predicate: RelationType,
  subjectType: EntityType,
  objectType: EntityType | null,
): boolean {
  const schema = RELATION_SCHEMA[predicate];
  if (schema.domain.length > 0 && !schema.domain.includes(subjectType)) return false;
  if (objectType !== null && schema.range.length > 0 && !schema.range.includes(objectType)) {
    return false;
  }
  return true;
}

/** Human/LLM-readable rendering of the schema; the extraction prompt embeds this verbatim. */
export function describeOntology(): string {
  const lines: string[] = ["Entity types (no others allowed):"];
  for (const type of ENTITY_TYPES) {
    const s = ENTITY_SCHEMA[type];
    lines.push(`- ${type} [${s.layer}]: ${s.description}`);
  }
  lines.push("", "Relation types (no others allowed), written as subject -> object:");
  for (const rel of RELATION_TYPES) {
    const s = RELATION_SCHEMA[rel];
    const domain = s.domain.length ? s.domain.join(" | ") : "any";
    const range = s.range.length ? s.range.join(" | ") : "any";
    lines.push(`- ${rel}: ${domain} -> ${range}. ${s.description}`);
  }
  return lines.join("\n");
}
