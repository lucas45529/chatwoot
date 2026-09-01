// Entscheidung und Buchfuehrung fuer automatisch gesendete Antworten.
//
// Die Gehirn-API entscheidet, ob eine Antwort inhaltlich sicher ist
// (`safeToAutoSend`). Hier kommt die betriebliche Bremse dazu: Kill-Switch,
// Obergrenzen und die dauerhafte Sperre, sobald ein Mensch im Gespraech
// geschrieben hat. Beides muss gelten, sonst bleibt es beim Entwurf.
import { createHmac } from 'node:crypto'
import type { TenantKey } from './domain.js'
import type { SupportBrainAnswer } from './support-brain.js'

/** Ueber dieser Laenge geht nichts automatisch raus, egal was das Gehirn sagt. */
const MAX_AUTO_SEND_CHARS = 1_200

export type AutoSendVerdict =
  | 'auto_send'
  | 'kill_switch_off'
  | 'brain_declined'
  | 'human_in_conversation'
  | 'conversation_limit'
  | 'contact_rate_limit'
  | 'text_too_long'

export interface AutoSendLimits {
  maxPerConversation: number
  maxPerContactPerHour: number
}

export interface AutoSendUsage {
  blocked: boolean
  conversationCount: number
  contactCountLastHour: number
}

export interface AutoSendRecord {
  tenantKey: TenantKey
  conversationId: number
  messageId: number
  contactHash?: string
  questionHash: string
  confidence: number
  sourceIds: readonly string[]
  sentText: string
}

export type AutoSendReservation =
  | {
      reserved: true
      usage: AutoSendUsage
      /** Bei Retries ist dies bewusst die zuerst reservierte, stabile Antwort. */
      entry: AutoSendRecord
    }
  | {
      reserved: false
      usage: AutoSendUsage
      verdict: 'human_in_conversation' | 'conversation_limit' | 'contact_rate_limit'
    }

export interface ConversationProcessingLock {
  runExclusive<Result>(
    tenantKey: TenantKey,
    conversationId: number,
    operation: () => Promise<Result>,
  ): Promise<Result>
}

export interface AutoSendLog {
  reserve(entry: AutoSendRecord, limits: AutoSendLimits): Promise<AutoSendReservation>
  blockConversation(input: {
    tenantKey: TenantKey
    conversationId: number
    reason: string
  }): Promise<void>

  /** Erst nach bestaetigter Chatwoot-Nachricht; trennt Audit-Versuch von Versand. */
  markSent(tenantKey: TenantKey, messageId: number): Promise<void>
}

const CONTACT_PSEUDONYM_DOMAIN = 'myinvest-claude-agent/contact/v1'
const QUESTION_PSEUDONYM_DOMAIN = 'myinvest-claude-agent/question/v1'
const SUPPORT_BRAIN_REQUEST_DOMAIN =
  'myinvest-claude-agent/support-brain-request/v1'

export function contactFingerprint(
  pseudonymizationKey: string,
  accountId: number,
  contactId: string,
): string {
  return createHmac('sha256', pseudonymizationKey)
    .update(`${CONTACT_PSEUDONYM_DOMAIN}\0${accountId}\0${contactId}`)
    .digest('hex')
}

/** Der Fragetext selbst wird nie auditiert, nur sein keyed Fingerabdruck. */
export function questionFingerprint(
  pseudonymizationKey: string,
  tenantKey: TenantKey,
  question: string,
): string {
  return createHmac('sha256', pseudonymizationKey)
    .update(`${QUESTION_PSEUDONYM_DOMAIN}\0${tenantKey}\0${question}`)
    .digest('hex')
}

/**
 * Bindet jede Gehirn-Anfrage stabil an die Chatwoot-Nachricht. Netz- und
 * Job-Retries verwenden dadurch denselben Replay-Key, ohne interne IDs
 * aufzudecken.
 */
export function supportBrainRequestId(
  pseudonymizationKey: string,
  accountId: number,
  messageId: number,
): string {
  const digest = createHmac('sha256', pseudonymizationKey)
    .update(`${SUPPORT_BRAIN_REQUEST_DOMAIN}\0${accountId}\0${messageId}`)
    .digest()
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function autoSendDecision(input: {
  enabled: boolean
  humanInConversation: boolean
  answer: SupportBrainAnswer
}): AutoSendVerdict {
  if (!input.enabled) return 'kill_switch_off'
  // `safeToAutoSend` ist die Serverentscheidung; action wird zusaetzlich
  // geprueft, damit eine Rueckfrage oder Uebergabe nie versehentlich rausgeht.
  if (!input.answer.safeToAutoSend || input.answer.action !== 'answer') return 'brain_declined'
  if (input.humanInConversation) return 'human_in_conversation'
  if (input.answer.text.trim().length === 0 || input.answer.text.length > MAX_AUTO_SEND_CHARS) {
    return 'text_too_long'
  }

  return 'auto_send'
}
