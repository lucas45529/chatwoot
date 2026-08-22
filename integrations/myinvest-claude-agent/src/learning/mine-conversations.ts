import { createHash } from 'node:crypto'
import type { TenantKey } from '../domain.js'
import {
  containsResidualPersonalData,
  directPersonalization,
  likelySecret,
  redactSupportText,
  sensitiveTopic,
  type KnowledgeCandidate,
} from './extractor.js'

// Selbstlern-Loop: Konversationen, in denen der Bot uebergab und ein Mensch
// geantwortet hat, liefern neue Wissens-Kandidaten ("die Frage hatte schon
// mal ein Kunde, die Antwort war XYZ"). Gleiche Redaction- und Guard-Regeln
// wie der HubSpot-Extractor; Veroeffentlichung nur nach menschlichem Review.
export const LIVE_SOURCE_NAMESPACE = 'chatwoot-live-v1'
const LIVE_REDACTION_VERSION = 3
const MAX_ANSWER_DELAY_MS = 24 * 60 * 60 * 1000

export interface LiveMessage {
  messageId: number
  messageType: number
  senderType: string
  private: boolean
  content: string
  createdAt: Date
}

export interface LiveConversation {
  conversationId: number
  handedOff: boolean
  messages: LiveMessage[]
}

export interface LiveExtraction {
  candidates: KnowledgeCandidate[]
  examinedConversations: number
  rejectedConversations: number
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function candidateFromLivePair(
  tenant: TenantKey,
  exportId: string,
  conversationId: number,
  question: LiveMessage,
  answer: LiveMessage,
): KnowledgeCandidate | null {
  const questionRedacted = redactSupportText(question.content)
  const answerRedacted = redactSupportText(answer.content)
  const combined = `${questionRedacted.text} ${answerRedacted.text}`
  if (containsResidualPersonalData(combined)) return null
  if (questionRedacted.text.length < 10 || answerRedacted.text.length < 10) return null
  if (questionRedacted.text.length > 1_000 || answerRedacted.text.length > 2_500) return null
  if (
    sensitiveTopic.test(combined) ||
    likelySecret.test(combined) ||
    directPersonalization.test(combined)
  ) {
    return null
  }
  const sourcePairDigest = sha256(`${question.messageId}\0${answer.messageId}`)
  return {
    candidateKey: sha256(`${LIVE_SOURCE_NAMESPACE}\0${sourcePairDigest}`),
    previousCandidateKeys: [],
    sourcePairDigest,
    sourceNamespace: LIVE_SOURCE_NAMESPACE,
    sourceExportId: exportId,
    sourceConversationDigest: sha256(`chatwoot:${conversationId}`),
    targetTenant: tenant,
    questionRedacted: questionRedacted.text,
    answerRedacted: answerRedacted.text,
    contentHash: sha256(`${questionRedacted.text}\0${answerRedacted.text}`),
    redactionCount: questionRedacted.redactionCount + answerRedacted.redactionCount,
    riskFlags: ['live_conversation_mining'],
    status: 'pending_review',
    redactionVersion: LIVE_REDACTION_VERSION,
  }
}

export function extractLiveCandidates(input: {
  tenant: TenantKey
  exportId: string
  conversations: LiveConversation[]
}): LiveExtraction {
  const candidates: KnowledgeCandidate[] = []
  let examinedConversations = 0
  let rejectedConversations = 0
  for (const conversation of input.conversations) {
    if (!conversation.handedOff) continue
    examinedConversations += 1
    const question = conversation.messages.find(
      (message) =>
        message.messageType === 0 &&
        message.senderType === 'Contact' &&
        !message.private &&
        message.content.trim().length > 0,
    )
    const answer = question
      ? conversation.messages.find(
          (message) =>
            message.messageType === 1 &&
            message.senderType === 'User' &&
            !message.private &&
            message.content.trim().length > 0 &&
            message.createdAt.getTime() > question.createdAt.getTime() &&
            message.createdAt.getTime() - question.createdAt.getTime() <= MAX_ANSWER_DELAY_MS,
        )
      : undefined
    const candidate =
      question && answer
        ? candidateFromLivePair(input.tenant, input.exportId, conversation.conversationId, question, answer)
        : null
    if (candidate) {
      candidates.push(candidate)
    } else {
      rejectedConversations += 1
    }
  }
  return { candidates, examinedConversations, rejectedConversations }
}
