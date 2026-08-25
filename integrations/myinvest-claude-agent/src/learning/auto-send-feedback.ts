// Nachlauf zu jeder automatisch gesendeten Antwort: hat sie gereicht?
//
// Ein Mensch, der kurz nach einer Auto-Antwort selbst schreibt, korrigiert sie
// faktisch — das ist das negative Signal. Wird das Gespraech danach ohne
// menschliche Nachricht geschlossen, war die Antwort gut genug. Beides landet
// im vorhandenen Lern-Feedback und damit im Review-Pfad.
import type { TenantRegistry } from '../config.js'
import { tenantKeySchema, type TenantKey } from '../domain.js'
import { redactSupportText } from './extractor.js'
import { recordLearningFeedback, type LearningPool } from './repository.js'

interface QueryResult<Row> {
  rows: Row[]
}

interface Queryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

interface PendingRow extends Record<string, unknown> {
  id: string
  tenant_key: string
  conversation_id: string
  message_id: string
  created_at: Date
}

interface OutcomeRow extends Record<string, unknown> {
  status: number
  human_reply_content: string | null
}

export interface AutoSendFeedbackSweepResult {
  evaluated: number
  helpful: number
  corrected: number
  undecided: number
}

type FeedbackRating = 'helpful' | 'unhelpful' | 'human_correction' | 'none'

/** Vor Ablauf dieser Frist hatte noch kein Mensch die Chance zu widersprechen. */
const GRACE_MINUTES = 30
/** Danach gilt eine Auto-Antwort als unbeanstandet und wird nicht mehr bewertet. */
const CORRECTION_WINDOW_MINUTES = 120
/** Unter dieser Laenge traegt eine Korrektur keine verwertbare Aussage. */
const MIN_CORRECTION_CHARS = 10
const MAX_ROWS_PER_SWEEP = 50
const CHATWOOT_STATUS_RESOLVED = 1

export async function runAutoSendFeedbackSweep(input: {
  agentPool: LearningPool & Queryable
  chatwootPool: Queryable
  tenants: TenantRegistry
  now?: () => number
}): Promise<AutoSendFeedbackSweepResult> {
  const pending = await input.agentPool.query<PendingRow>(
    `SELECT id, tenant_key, conversation_id::text AS conversation_id,
            message_id::text AS message_id, created_at
       FROM agent_auto_send_log
      WHERE feedback_recorded_at IS NULL
        AND created_at < now() - ($1 || ' minutes')::interval
        AND created_at > now() - interval '7 days'
      ORDER BY created_at
      LIMIT $2`,
    [GRACE_MINUTES, MAX_ROWS_PER_SWEEP],
  )
  const result: AutoSendFeedbackSweepResult = {
    evaluated: 0,
    helpful: 0,
    corrected: 0,
    undecided: 0,
  }
  const nowMs = input.now?.() ?? Date.now()
  for (const row of pending.rows) {
    const tenantKey = tenantKeySchema.safeParse(row.tenant_key)
    if (!tenantKey.success) continue
    const tenant = input.tenants.requireByKey(tenantKey.data)
    const conversationId = Number(row.conversation_id)
    const sentAt = new Date(row.created_at)
    const outcome = await input.chatwootPool.query<OutcomeRow>(
      `SELECT conversation.status,
              (
                SELECT reply.content
                  FROM messages AS reply
                 WHERE reply.account_id = $1
                   AND reply.conversation_id = conversation.id
                   AND reply.sender_type = 'User'
                   AND reply.private = false
                   AND reply.created_at > $3
                   AND reply.created_at <= $3 + ($4 || ' minutes')::interval
                 ORDER BY reply.created_at ASC
                 LIMIT 1
              ) AS human_reply_content
         FROM conversations AS conversation
        WHERE conversation.account_id = $1
          AND conversation.display_id = $2`,
      [tenant.accountId, conversationId, sentAt, CORRECTION_WINDOW_MINUTES],
    )
    const conversation = outcome.rows[0]
    // Redaction vor der Bewertung: der Korrekturtext wird gespeichert, also
    // entscheidet die redigierte Fassung ueber seine Verwertbarkeit.
    const correction = conversation?.human_reply_content
      ? redactSupportText(conversation.human_reply_content).text.trim()
      : ''
    const rating: FeedbackRating | undefined = !conversation
      ? 'none'
      : feedbackRating({
          correction,
          humanReplied: Boolean(conversation.human_reply_content),
          resolved: conversation.status === CHATWOOT_STATUS_RESOLVED,
          windowClosed: nowMs - sentAt.getTime() > CORRECTION_WINDOW_MINUTES * 60_000,
        })
    if (!rating) continue
    if (rating !== 'none') {
      await recordFeedbackSafely(input.agentPool, {
        tenantKey: tenantKey.data,
        conversationId,
        sourceMessageId: Number(row.message_id),
        rating,
        correction: rating === 'human_correction' ? correction : undefined,
      })
    }
    await input.agentPool.query(
      `UPDATE agent_auto_send_log
          SET feedback_rating = $2, feedback_recorded_at = now()
        WHERE id = $1 AND feedback_recorded_at IS NULL`,
      [row.id, rating],
    )
    result.evaluated += 1
    if (rating === 'helpful') result.helpful += 1
    else if (rating === 'none') result.undecided += 1
    else result.corrected += 1
  }
  return result
}

function feedbackRating(input: {
  correction: string
  humanReplied: boolean
  resolved: boolean
  windowClosed: boolean
}): FeedbackRating | undefined {
  // Ein Mensch hat nachgelegt: die Auto-Antwort hat nicht gereicht. Mit
  // verwertbarem Text wird daraus eine Korrektur, sonst nur ein Minus.
  if (input.humanReplied) {
    return input.correction.length >= MIN_CORRECTION_CHARS ? 'human_correction' : 'unhelpful'
  }
  if (input.resolved) return 'helpful'
  // Weder Widerspruch noch Abschluss: erst wenn das Zeitfenster zu ist, wird
  // die Zeile geschlossen — vorher bleibt sie offen fuer den naechsten Lauf.
  return input.windowClosed ? 'none' : undefined
}

/**
 * Ein einzelner Feedback-Fehlschlag darf den Durchlauf nicht abbrechen: die
 * Zeile wird trotzdem geschlossen, sonst laeuft jeder Sweep gegen dieselbe.
 */
async function recordFeedbackSafely(
  pool: LearningPool,
  input: {
    tenantKey: TenantKey
    conversationId: number
    sourceMessageId: number
    rating: 'helpful' | 'unhelpful' | 'human_correction'
    correction?: string
  },
): Promise<void> {
  try {
    await recordLearningFeedback(pool, input)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'agent_auto_send_feedback_failed',
        tenant: input.tenantKey,
        conversationId: input.conversationId,
        rating: input.rating,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
