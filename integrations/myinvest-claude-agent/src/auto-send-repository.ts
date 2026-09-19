import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type {
  AutoSendLimits,
  AutoSendLog,
  AutoSendRecord,
  AutoSendReservation,
  AutoSendUsage,
  ConversationProcessingLock,
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

interface DatabaseClient extends Queryable {
  release(destroy?: boolean): void
}

interface DatabasePool extends Queryable {
  connect(): Promise<DatabaseClient>
}

interface ReservationRow extends Record<string, unknown> {
  blocked: boolean
  conversation_count: string | number
  contact_count: string | number
  reservation_message_id: string | number | null
  reservation_contact_hash: string | null
  reservation_question_hash: string | null
  reservation_confidence: string | number | null
  reservation_source_ids: unknown
  reservation_sent_text: string | null
}

const PRIVATE_DOCUMENT_SOURCE = 'urn:myinvest:private-document-delivery:v1'

const conversationAutoSendLockKey = (tenantKey: TenantKey, conversationId: number) =>
  `myinvest-agent:auto-send:${tenantKey}:${conversationId}`

const contactAutoSendLockKey = (tenantKey: TenantKey, contactHash: string) =>
  `myinvest-agent:auto-send-contact:${tenantKey}:${contactHash}`

async function transaction<Result>(
  database: DatabasePool,
  operation: (client: DatabaseClient) => Promise<Result>,
): Promise<Result> {
  const client = await database.connect()
  let destroyClient = false
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      destroyClient = true
      throw new AggregateError(
        [error, rollbackError],
        'Auto-send transaction and rollback both failed',
      )
    }
    throw error
  } finally {
    client.release(destroyClient)
  }
}

async function lockConversationTransaction(
  client: Queryable,
  tenantKey: TenantKey,
  conversationId: number,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [conversationAutoSendLockKey(tenantKey, conversationId)],
  )
}

export class PostgresConversationProcessingLock implements ConversationProcessingLock {
  constructor(private readonly database: DatabasePool) {}
  async runExclusive<Result>(
    tenantKey: TenantKey,
    conversationId: number,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const client = await this.database.connect()
    let locked = false
    let operationFailed = false
    let released = false
    try {
      await client.query(
        'SELECT pg_advisory_lock(hashtextextended($1, 0))',
        [`myinvest-agent:processing:${tenantKey}:${conversationId}`],
      )
      locked = true
      return await operation()
    } catch (error) {
      operationFailed = true
      throw error
    } finally {
      if (locked) {
        try {
          await client.query(
            'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
            [`myinvest-agent:processing:${tenantKey}:${conversationId}`],
          )
        } catch (unlockError) {
          client.release(true)
          released = true
          if (!operationFailed) throw unlockError
        }
      }
      if (!released) client.release()
    }
  }
}

export class PostgresAutoSendLog implements AutoSendLog {
  constructor(private readonly database: DatabasePool, private readonly encryptionSecret?: string) {}

  private documentKey(): Buffer {
    if (!this.encryptionSecret || this.encryptionSecret.length < 32) throw new Error('Private delivery encryption unavailable')
    return Buffer.from(hkdfSync('sha256', this.encryptionSecret, 'myinvest-agent/private-delivery/v1', 'document-sent-text/aes-256-gcm', 32))
  }

  private documentAad(entry: AutoSendRecord): Buffer {
    return Buffer.from(JSON.stringify(['myinvest-agent/private-delivery/v1', entry.tenantKey, entry.conversationId, entry.messageId]))
  }

  private storedText(entry: AutoSendRecord): string {
    if (!entry.sensitive) return entry.sentText
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.documentKey(), iv)
    cipher.setAAD(this.documentAad(entry))
    const encrypted = Buffer.concat([cipher.update(entry.sentText, 'utf8'), cipher.final()])
    return `private:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`
  }

  private restoredText(stored: string, entry: AutoSendRecord): string {
    if (!stored.startsWith('private:')) {
      if (entry.sensitive) throw new Error('Private delivery reservation is not encrypted')
      return stored
    }
    const parts = stored.split(':')
    if (parts.length !== 5 || parts[1] !== 'v1') throw new Error('Invalid private delivery envelope')
    const iv = Buffer.from(parts[2]!, 'base64url')
    const tag = Buffer.from(parts[3]!, 'base64url')
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid private delivery envelope')
    const decipher = createDecipheriv('aes-256-gcm', this.documentKey(), iv)
    decipher.setAAD(this.documentAad(entry))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(parts[4]!, 'base64url')), decipher.final()]).toString('utf8')
  }

  async reserve(
    entry: AutoSendRecord,
    limits: AutoSendLimits,
  ): Promise<AutoSendReservation> {
    return transaction(this.database, async (client) => {
      await lockConversationTransaction(client, entry.tenantKey, entry.conversationId)
      if (entry.contactHash) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [contactAutoSendLockKey(entry.tenantKey, entry.contactHash)],
        )
      }

      const result = await client.query<ReservationRow>(
        `WITH usage AS MATERIALIZED (
           SELECT EXISTS(
                    SELECT 1 FROM agent_auto_send_blocks
                     WHERE tenant_key = $1 AND conversation_id = $2
                  ) AS blocked,
                  (SELECT count(*) FROM agent_auto_send_log
                    WHERE tenant_key = $1 AND conversation_id = $2
                      AND message_id <> $3) AS conversation_count,
                  (SELECT count(*) FROM agent_auto_send_log
                    WHERE tenant_key = $1
                      AND contact_hash IS NOT NULL AND contact_hash = $4
                      AND message_id <> $3
                      AND created_at >= now() - interval '1 hour') AS contact_count
         ), inserted AS (
           INSERT INTO agent_auto_send_log
             (tenant_key, conversation_id, message_id, contact_hash, question_hash,
              confidence, source_ids, sent_text)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8
             FROM usage
            WHERE NOT blocked
              AND conversation_count < $9
              AND contact_count < $10
           ON CONFLICT (tenant_key, message_id) DO NOTHING
           RETURNING message_id, contact_hash, question_hash, confidence, source_ids, sent_text
         ), reservation AS (
           SELECT message_id, contact_hash, question_hash, confidence, source_ids, sent_text
             FROM inserted
           UNION ALL
           SELECT existing.message_id, existing.contact_hash, existing.question_hash,
                  existing.confidence, existing.source_ids, existing.sent_text
             FROM agent_auto_send_log AS existing
             CROSS JOIN usage
            WHERE existing.tenant_key = $1
              AND existing.conversation_id = $2
              AND existing.message_id = $3
              AND NOT usage.blocked
              AND usage.conversation_count < $9
              AND usage.contact_count < $10
           LIMIT 1
         )
         SELECT usage.blocked, usage.conversation_count, usage.contact_count,
                reservation.message_id AS reservation_message_id,
                reservation.contact_hash AS reservation_contact_hash,
                reservation.question_hash AS reservation_question_hash,
                reservation.confidence AS reservation_confidence,
                reservation.source_ids AS reservation_source_ids,
                reservation.sent_text AS reservation_sent_text
           FROM usage
           LEFT JOIN reservation ON true`,
        [
          entry.tenantKey,
          entry.conversationId,
          entry.messageId,
          entry.contactHash ?? null,
          entry.questionHash,
          entry.confidence,
          entry.sensitive ? [PRIVATE_DOCUMENT_SOURCE] : [...entry.sourceIds],
          this.storedText(entry),
          limits.maxPerConversation,
          limits.maxPerContactPerHour,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('Auto-send reservation could not be evaluated')
      const usage: AutoSendUsage = {
        blocked: row.blocked === true,
        conversationCount: Number(row.conversation_count),
        contactCountLastHour: Number(row.contact_count),
      }
      if (usage.blocked) return rejected('human_in_conversation', usage)
      if (usage.conversationCount >= limits.maxPerConversation) {
        return rejected('conversation_limit', usage)
      }
      if (usage.contactCountLastHour >= limits.maxPerContactPerHour) {
        return rejected('contact_rate_limit', usage)
      }
      if (row.reservation_message_id === null) {
        throw new Error('Auto-send message conflicts with an existing reservation')
      }
      if (
        row.reservation_question_hash === null ||
        row.reservation_confidence === null ||
        row.reservation_sent_text === null ||
        !Array.isArray(row.reservation_source_ids)
      ) {
        throw new Error('Auto-send reservation is incomplete')
      }
      const sourceIds: string[] = []
      for (const sourceId of row.reservation_source_ids) {
        if (typeof sourceId !== 'string') {
          throw new Error('Auto-send reservation source ID is invalid')
        }
        sourceIds.push(sourceId)
      }
      const sensitive = sourceIds.includes(PRIVATE_DOCUMENT_SOURCE) || row.reservation_sent_text.startsWith('private:')
      return {
        reserved: true,
        usage,
        entry: {
          tenantKey: entry.tenantKey,
          conversationId: entry.conversationId,
          messageId: Number(row.reservation_message_id),
          contactHash: row.reservation_contact_hash ?? undefined,
          questionHash: row.reservation_question_hash,
          confidence: Number(row.reservation_confidence),
          sourceIds: sensitive ? [] : sourceIds,
          sentText: this.restoredText(row.reservation_sent_text, { ...entry, sensitive: sensitive || entry.sensitive }),
          ...(sensitive ? { sensitive: true } : {}),
        },
      }
    })
  }

  async blockConversation(input: {
    tenantKey: TenantKey
    conversationId: number
    reason: string
  }): Promise<void> {
    await transaction(this.database, async (client) => {
      await lockConversationTransaction(client, input.tenantKey, input.conversationId)
      await client.query(
        `INSERT INTO agent_auto_send_blocks (tenant_key, conversation_id, reason)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_key, conversation_id) DO NOTHING`,
        [input.tenantKey, input.conversationId, input.reason],
      )
    })
  }

  async markSent(tenantKey: TenantKey, messageId: number): Promise<void> {
    const result = await this.database.query<{ updated: number }>(
      `UPDATE agent_auto_send_log
          SET sent_at = COALESCE(sent_at, now())
        WHERE tenant_key = $1 AND message_id = $2
        RETURNING 1 AS updated`,
      [tenantKey, messageId],
    )
    if (!result.rows[0]) throw new Error('Auto-send audit row could not be marked sent')
  }
}

function rejected(
  verdict: 'human_in_conversation' | 'conversation_limit' | 'contact_rate_limit',
  usage: AutoSendUsage,
): AutoSendReservation {
  return { reserved: false, verdict, usage }
}
