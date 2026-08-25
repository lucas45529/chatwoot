import type {
  AutoSendLog,
  AutoSendRecord,
  AutoSendUsage,
} from './auto-send.js'
import type { TenantKey } from './domain.js'

interface QueryResult<Row> {
  rows: Row[]
}

interface Queryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

interface UsageRow extends Record<string, unknown> {
  blocked: boolean
  conversation_count: string | number
  contact_count: string | number
}

export class PostgresAutoSendLog implements AutoSendLog {
  constructor(private readonly database: Queryable) {}

  /** Ein Roundtrip: Sperre und beide Zaehler stehen vor jedem Auto-Send fest. */
  async usage(input: {
    tenantKey: TenantKey
    conversationId: number
    contactHash?: string
  }): Promise<AutoSendUsage> {
    const result = await this.database.query<UsageRow>(
      `SELECT EXISTS(
                SELECT 1 FROM agent_auto_send_blocks
                 WHERE tenant_key = $1 AND conversation_id = $2
              ) AS blocked,
              (SELECT count(*) FROM agent_auto_send_log
                WHERE tenant_key = $1 AND conversation_id = $2) AS conversation_count,
              (SELECT count(*) FROM agent_auto_send_log
                WHERE tenant_key = $1 AND contact_hash IS NOT NULL AND contact_hash = $3
                  AND created_at >= now() - interval '1 hour') AS contact_count`,
      [input.tenantKey, input.conversationId, input.contactHash ?? null],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Auto-send usage could not be read')
    return {
      blocked: row.blocked === true,
      conversationCount: Number(row.conversation_count),
      contactCountLastHour: Number(row.contact_count),
    }
  }

  async blockConversation(input: {
    tenantKey: TenantKey
    conversationId: number
    reason: string
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO agent_auto_send_blocks (tenant_key, conversation_id, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_key, conversation_id) DO NOTHING`,
      [input.tenantKey, input.conversationId, input.reason],
    )
  }

  /**
   * Die Zeile wird vor dem Senden geschrieben. Ein abgebrochener Sendeversuch
   * darf die Obergrenze nie ausweiten; im Zweifel wird lieber zu frueh gezaehlt
   * als zu oft gesendet.
   */
  async record(entry: AutoSendRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO agent_auto_send_log
         (tenant_key, conversation_id, message_id, contact_hash, question_hash,
          confidence, source_ids, sent_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_key, message_id) DO NOTHING`,
      [
        entry.tenantKey,
        entry.conversationId,
        entry.messageId,
        entry.contactHash ?? null,
        entry.questionHash,
        entry.confidence,
        [...entry.sourceIds],
        entry.sentText,
      ],
    )
  }
}
