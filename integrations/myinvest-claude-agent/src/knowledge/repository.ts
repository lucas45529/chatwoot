import type { KnowledgeHit, TenantKey } from '../domain.js'

interface QueryResult<Row> {
  rows: Row[]
}

interface Queryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

interface KnowledgeRow extends Record<string, unknown> {
  source_id: string
  title: string
  content: string
  metadata: Record<string, unknown>
  score: number | string
}

export interface KnowledgeRepository {
  search(
    tenantKey: TenantKey,
    query: string,
    limit: number,
    minScore?: number,
  ): Promise<KnowledgeHit[]>
}

const SEARCH_BODY = `
       SELECT d.source_id, d.title, d.content, d.metadata,
              ts_rank_cd(d.search_vector, input.query)::float AS score
       FROM agent_knowledge_documents d, input
       WHERE d.tenant_key = $1
         AND d.publication_status = 'published'
         AND d.active = true
         AND (
           d.learning_candidate_id IS NULL
           OR EXISTS (
             SELECT 1 FROM agent_knowledge_candidates c
             WHERE c.id = d.learning_candidate_id
               AND c.target_tenant = d.tenant_key
               AND c.published_document_id = d.id
               AND c.status = 'published'
               AND c.reviewed_by = 'intern-support-review'
               AND EXISTS (
                 SELECT 1 FROM agent_learning_audit_events a
                 WHERE a.candidate_id = c.id
                   AND a.tenant_key = c.target_tenant
                   AND a.action = 'published'
                   AND a.actor = 'intern-support-review'
               )
           )
         )
         AND d.search_vector @@ input.query
       ORDER BY score DESC, d.source_id ASC
       LIMIT $3`

// websearch_to_tsquery AND-verknuepft alle Lexeme: ein einziges unbekanntes
// Wort in einer natuerlichen Kundenfrage loescht sonst jeden Treffer.
const STRICT_QUERY = `WITH input AS (
         SELECT websearch_to_tsquery('german', $2) AS query
       )${SEARCH_BODY}`

// Fallback bei null Treffern: OR-Verknuepfung der Lexeme, das Ranking sortiert.
// Die Frage wird zusaetzlich ae/oe/ue/ss-normalisiert angehaengt, damit beide
// Schreibweisen gegen den ebenfalls normalisierten Suchvektor (Migration 005)
// matchen — sonst verfehlt z.B. "Förderung" das Dokument "KfW-Foerderung".
const RELAXED_QUERY = `WITH input AS (
         SELECT replace(plainto_tsquery('german',
                  $2 || ' ' || replace(replace(replace(replace(lower($2),
                    'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss')
                )::text, ' & ', ' | ')::tsquery AS query
       )${SEARCH_BODY}`

export class PostgresKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly database: Queryable) {}

  async search(
    tenantKey: TenantKey,
    query: string,
    limit: number,
    minScore = 0,
  ): Promise<KnowledgeHit[]> {
    const strict = await this.runQuery(STRICT_QUERY, tenantKey, query, limit)
    if (strict[0] && strict[0].score >= minScore) {
      return strict
    }
    // Strikte Treffer unter der Schwelle sind faktisch ein Miss: dann zaehlt
    // der OR-Fallback, sonst handoff't der Prozessor trotz passender Dokumente.
    const relaxed = await this.runQuery(RELAXED_QUERY, tenantKey, query, limit)
    if (relaxed.length === 0) {
      return strict
    }
    if (strict.length > 0 && relaxed[0] && strict[0]!.score > relaxed[0].score) {
      return strict
    }
    return relaxed
  }

  private async runQuery(
    sql: string,
    tenantKey: TenantKey,
    query: string,
    limit: number,
  ): Promise<KnowledgeHit[]> {
    const result = await this.database.query<KnowledgeRow>(sql, [tenantKey, query, limit])
    return result.rows.map((row) => ({
      sourceId: row.source_id,
      title: row.title,
      content: row.content,
      metadata: row.metadata,
      score: Number(row.score),
    }))
  }
}
