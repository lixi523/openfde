import { ExtractionResult, relationFits, type EntityType, type EpisodeKind } from "@openfde/ontology";
import type { Ledger } from "./database.js";
import { newId, nowIso } from "./database.js";
import type { Extractor } from "../extraction/extractor.js";
import { resolveEntity, resolveFact } from "./resolve.js";
import { cjkSegment } from "./search.js";

export interface IngestInput {
  kind: EpisodeKind;
  content: string;
  /** Provenance hard constraint: content without a source is rejected */
  sourceUri: string;
  span?: string;
  speaker?: string;
  occurredAt?: string;
  /** For PDF/image episodes: path of the copy under the engagement raw/ dir */
  mediaPath?: string;
  mediaType?: string;
}

export interface EpisodeRow {
  id: string;
  kind: string;
  content: string;
  source_uri: string;
  speaker: string | null;
  occurred_at: string | null;
  media_path: string | null;
  media_type: string | null;
  extraction_status: string;
}

export function ingestEpisode(db: Ledger, input: IngestInput): string {
  if (!input.sourceUri?.trim()) {
    throw new Error("rejected: an episode must carry a source_uri (provenance hard constraint)");
  }
  if (!input.content?.trim()) {
    throw new Error("rejected: episode content is empty");
  }
  const id = newId("ep");
  db.prepare(
    `INSERT INTO episodes (id, kind, content, source_uri, span, speaker, occurred_at, media_path, media_type, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.content,
    input.sourceUri,
    input.span ?? null,
    input.speaker ?? null,
    input.occurredAt ?? null,
    input.mediaPath ?? null,
    input.mediaType ?? null,
    nowIso(),
  );
  // raw content is searchable immediately, before extraction runs
  db.prepare(`INSERT INTO episode_fts (content, episode_id) VALUES (?, ?)`).run(
    cjkSegment(input.content),
    id,
  );
  return id;
}

export interface ExtractionStats {
  episodes: number;
  entities: number;
  facts: { ADD: number; UPDATE: number; INVALIDATE: number; NOOP: number };
  /** Facts whose relation violated its domain/range and were coerced to RELATES_TO */
  coerced: number;
  failed: number;
}

/** Run extract → resolve → persist over all pending episodes */
export async function runExtraction(db: Ledger, extractor: Extractor): Promise<ExtractionStats> {
  const pending = db
    .prepare(`SELECT * FROM episodes WHERE extraction_status = 'pending' ORDER BY ingested_at`)
    .all() as EpisodeRow[];

  const stats: ExtractionStats = {
    episodes: 0,
    entities: 0,
    facts: { ADD: 0, UPDATE: 0, INVALIDATE: 0, NOOP: 0 },
    coerced: 0,
    failed: 0,
  };

  for (const episode of pending) {
    let result;
    try {
      result = ExtractionResult.parse(
        await extractor.extract({
          kind: episode.kind,
          content: episode.content,
          speaker: episode.speaker,
          occurredAt: episode.occurred_at,
          mediaPath: episode.media_path,
          mediaType: episode.media_type,
        }),
      );
    } catch (error) {
      db.prepare(`UPDATE episodes SET extraction_status = 'failed' WHERE id = ?`).run(episode.id);
      stats.failed += 1;
      continue;
    }

    const write = db.transaction(() => {
      const entityIdByName = new Map<string, string>();
      const entityTypeByName = new Map<string, EntityType>();
      for (const draft of result.entities) {
        const row = resolveEntity(db, draft);
        if (!entityIdByName.has(draft.name)) stats.entities += 1;
        entityIdByName.set(draft.name, row.id);
        entityTypeByName.set(draft.name, row.type as EntityType);
      }
      for (const rawDraft of result.facts) {
        const subjectId = entityIdByName.get(rawDraft.subject);
        if (!subjectId) continue; // fact references an undeclared entity: drop the fact, keep the episode
        const objectId = rawDraft.object ? (entityIdByName.get(rawDraft.object) ?? null) : null;
        if (rawDraft.object && !objectId) continue;
        // Schema validation at write time: a relation whose subject/object types fall
        // outside its declared domain/range is kept (the statement and quote are real)
        // but coerced to RELATES_TO, so projections never see an impossible triple.
        let draft = rawDraft;
        const subjectType = entityTypeByName.get(rawDraft.subject)!;
        const objectType = rawDraft.object ? (entityTypeByName.get(rawDraft.object) ?? null) : null;
        if (!relationFits(rawDraft.predicate, subjectType, objectType)) {
          draft = { ...rawDraft, predicate: "RELATES_TO" };
          stats.coerced += 1;
        }
        const resolved = resolveFact(db, draft, subjectId, objectId, episode.id);
        stats.facts[resolved.op as keyof typeof stats.facts] += 1;
      }
      db.prepare(`UPDATE episodes SET extraction_status = 'done' WHERE id = ?`).run(episode.id);
    });
    write();
    stats.episodes += 1;
  }
  return stats;
}
