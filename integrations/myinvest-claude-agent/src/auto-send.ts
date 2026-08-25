// Entscheidung und Buchfuehrung fuer automatisch gesendete Antworten.
//
// Die Gehirn-API entscheidet, ob eine Antwort inhaltlich sicher ist
// (`safeToAutoSend`). Hier kommt die betriebliche Bremse dazu: Kill-Switch,
// Obergrenzen und die dauerhafte Sperre, sobald ein Mensch im Gespraech
// geschrieben hat. Beides muss gelten, sonst bleibt es beim Entwurf.
import { createHash } from 'node:crypto'
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
  /** Menschliche Beteiligung wurde in dieser Konversation dauerhaft vermerkt. */
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

export interface AutoSendLog {
  usage(input: {
    tenantKey: TenantKey
    conversationId: number
    /** Aktuelle Delivery; ihr voriger Fehlversuch zaehlt beim Retry nicht doppelt. */
    messageId: number
    contactHash?: string
  }): Promise<AutoSendUsage>
  blockConversation(input: {
    tenantKey: TenantKey
    conversationId: number
    reason: string
  }): Promise<void>
  record(entry: AutoSendRecord): Promise<void>
  /** Erst nach bestaetigter Chatwoot-Nachricht; trennt Audit-Versuch von Versand. */
  markSent(tenantKey: TenantKey, messageId: number): Promise<void>
}

/** Der Fragetext selbst wird nie auditiert, nur sein Hash. */
export function questionFingerprint(tenantKey: TenantKey, question: string): string {
  return createHash('sha256').update(`${tenantKey}\0${question}`).digest('hex')
}

export function autoSendDecision(input: {
  enabled: boolean
  humanInConversation: boolean
  answer: SupportBrainAnswer
  usage: AutoSendUsage
  limits: AutoSendLimits
}): AutoSendVerdict {
  if (!input.enabled) return 'kill_switch_off'
  // `safeToAutoSend` ist die Serverentscheidung; action wird zusaetzlich
  // geprueft, damit eine Rueckfrage oder Uebergabe nie versehentlich rausgeht.
  if (!input.answer.safeToAutoSend || input.answer.action !== 'answer') return 'brain_declined'
  if (input.humanInConversation || input.usage.blocked) return 'human_in_conversation'
  if (input.answer.text.trim().length === 0 || input.answer.text.length > MAX_AUTO_SEND_CHARS) {
    return 'text_too_long'
  }
  if (input.usage.conversationCount >= input.limits.maxPerConversation) return 'conversation_limit'
  if (input.usage.contactCountLastHour >= input.limits.maxPerContactPerHour) {
    return 'contact_rate_limit'
  }
  return 'auto_send'
}
