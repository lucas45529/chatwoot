import { redactConversationText } from './conversation-history.js'
import {
  autoSendDecision,
  hasBoundAutomation,
  questionFingerprint,
  supportBrainRequestId,
  type AutoSendLimits,
  type AutoSendLog,
  type AutoSendVerdict,
  type ConversationProcessingLock,
} from './auto-send.js'
import type { ChatwootPort } from './chatwoot-client.js'
import type { AudioTranscriptionPort } from './audio-transcription.js'
import type { ChatwootConversationContextStore } from './chatwoot-delivery-repository.js'
import type { TenantConfig } from './config.js'
import type { ChatwootWebhookPayload, ConversationContext, TenantKey } from './domain.js'
import type { AgentState } from './state.js'
import type {
  SupportBrainAnswer,
  SupportExecutionContext,
  SupportBrainHistoryTurn,
  SupportBrainPort,
} from './support-brain.js'
import { privateLearningReferences } from './support-brain.js'
import { resolveSupportRoute, type SupportRoute } from './support-routing.js'
import { directSupportReply, handoffNote, normalizeForTriage, triage, type TriageOutcome } from './triage.js'

/**
 * Spiegel der humanOnly-Kategorien der Triage: wer eines dieser Labels traegt,
 * gehoert einem Menschen. `termin` und `zugang` stehen bewusst nicht hier — die
 * Gehirn-Policy entscheidet dort inhaltlich.
 */
const HUMAN_ONLY_LABELS: Record<string, true> = {
  sicherheitsverdacht: true,
  datenschutz: true,
  beschwerde: true,
  zahlung: true,
  beratung: true,
  urgent: true,
  billing: true,
  'mensch-gewuenscht': true,
}

const ATTACHMENT_REVIEW_DRAFT =
  'Danke für den Anhang. Was genau sollen wir darin prüfen, und an welcher Stelle tritt das Problem auf?'

/** Narrow read-only exception for copies of the customer's own documents.
 * Remove document nouns before reusing triage so an invoice cannot mask an
 * explicit human request (the billing rule normally wins before that rule). */
function isOwnDocumentReview(question: string, outcome: TriageOutcome, labels: readonly string[], documentFlowActive = false): boolean {
  const text = normalizeForTriage(question)
  const document = /\b(?:vertrag\w*|vertraege\w*|rechnung\w*|invoices?)\b/g
  const invoiceStatusFollowup = documentFlowActive && /^(?:im portal bestaetigt[.!? ]*)?welche rechnung(?:en)? (?:ist|sind) (?:noch )?(?:offen|bezahlt)[.!? ]*$/.test(text)
  if (!document.test(text) || (!invoiceStatusFollowup && !/\b(?:mein\w*|mir|bitte|kopie|pdf|send\w*|schick\w*|bekomm\w*|sehen|vertragsfrage)\b/.test(text))) return false
  if (!['zahlung', 'beratung', 'allgemein'].includes(outcome.category)) return false
  if (labels.some(label => HUMAN_ONLY_LABELS[label] && !['zahlung', 'beratung'].includes(label))) return false
  if (/\b(?:dringend|urgent|sofort|rechts\w*|rechtlich\w*|berat\w*|klausel\w*|haftung\w*|pruef\w*|kuendig\w*|widerruf\w*|storn\w*|erstatt\w*|kund\w*|fremd\w*)\b/.test(text)) return false
  const residual = triage(text.replace(document, ' '))
  return !residual.humanOnly && residual.category !== 'beratung'
}

export class MessageProcessor {
  constructor(
    private readonly dependencies: {
      brain: SupportBrainPort
      chatwoot: ChatwootPort
      audio?: AudioTranscriptionPort
      context: ChatwootConversationContextStore
      state: AgentState
      autoSend: AutoSendLog & {
        reconcileStaleHumanReply?(input: {
          tenantKey: TenantKey
          conversationId: number
          accountId: number
          inboxId: number
          currentMessageId: number
        }): Promise<boolean>
      }
      conversationLock: ConversationProcessingLock
      pseudonymizationKey: string
      autoSendEnabled: boolean
      autoSendLimits: AutoSendLimits
      whatsappInboxIds: ReadonlySet<number>
    },
  ) {}

  async process(input: {
    tenant: TenantConfig
    payload: ChatwootWebhookPayload
    isFinalAttempt?: boolean
  }): Promise<void> {
    await this.dependencies.conversationLock.runExclusive(
      input.tenant.key,
      input.payload.conversation.id,
      () => this.processExclusive(input),
    )
  }

  private async processExclusive(input: {
    tenant: TenantConfig
    payload: ChatwootWebhookPayload
    isFinalAttempt?: boolean
  }): Promise<void> {
    const { tenant, payload, isFinalAttempt = true } = input
    const conversationId = payload.conversation.id
    const conversationContext = await this.dependencies.context.loadContext({
      accountId: tenant.accountId,
      inboxId: tenant.inboxId,
      conversationDisplayId: conversationId,
      currentMessageId: payload.id,
    })
    if (!conversationContext) {
      console.error(
        JSON.stringify({
          event: 'agent_context_missing',
          tenant: tenant.key,
          conversationId,
        }),
      )
      throw new Error('Chatwoot conversation context is unavailable')
    }
    const supportRoute = this.supportRoute(tenant, conversationContext)
    if (!supportRoute) throw new Error('Chatwoot support routing is invalid')
    const crossProduct = supportRoute.tenant !== tenant.key
    let wasHandedOff = await this.dependencies.state.isHandedOff(
      tenant.key,
      conversationId,
    )
    const humanOnlyLabel = hasHumanOnlyLabel(conversationContext.labels)
    if (
      wasHandedOff &&
      conversationContext.humanRepliedAfterBot &&
      !humanOnlyLabel
    ) {
      await this.dependencies.state.activateConversation(tenant.key, conversationId)
    }

    const delivery = await this.dependencies.state.beginDelivery(
      tenant.key,
      payload.id,
      conversationId,
    )
    // replied/handed_off = Terminalzustand. processing/sending = ein anderer
    // Worker besitzt die Lieferung; Retry-Sentinels werden atomar neu erworben.
    if (!delivery.acquired) {
      if (delivery.status === 'processing' || delivery.status === 'sending') {
        console.log(
          JSON.stringify({
            event: 'agent_delivery_owned_elsewhere',
            tenant: tenant.key,
            conversationId,
            messageId: payload.id,
            status: delivery.status,
          }),
        )
      }
      return
    }

    const rawQuestion = payload.content.trim()
    let executionContext: SupportExecutionContext | undefined
    let hasAudioAttachment = false
    let audioAttachment: { id: number; byteSize: number } | undefined
    if (this.dependencies.context.loadCurrentSource) {
      const fresh = await this.dependencies.context.loadCurrentSource({ accountId: tenant.accountId, inboxId: tenant.inboxId, conversationDisplayId: conversationId, currentMessageId: payload.id, tenant: supportRoute.tenant, channel: supportRoute.channel })
      const identity = fresh?.executionContext
      if (!identity || identity.accountId !== payload.account.id || identity.accountId !== tenant.accountId || identity.inboxId !== tenant.inboxId || (payload.inboxId !== undefined && identity.inboxId !== payload.inboxId) || identity.conversationId !== conversationId || identity.sourceMessageId !== payload.id || Date.parse(identity.sourceReceivedAt) !== Date.parse(payload.created_at) || fresh.content.trim() !== rawQuestion || payload.event !== 'message_created' || payload.message_type !== 'incoming' || payload.private || payload.agentAction === 'preprocessed') {
        await this.completeSuperseded(tenant.key, payload.id)
        return
      }
      executionContext = identity
      hasAudioAttachment = fresh.hasAudioAttachment === true || Boolean(fresh.audioAttachment)
      audioAttachment = fresh.audioAttachment
    }
    if (
      this.dependencies.autoSendEnabled &&
      executionContext &&
      !conversationContext.humanEverReplied &&
      !conversationContext.humanRepliedAfterBot &&
      !conversationContext.turns.some((turn) => turn.role === 'human') &&
      !humanOnlyLabel &&
      await this.dependencies.autoSend.reconcileStaleHumanReply?.({
        tenantKey: tenant.key,
        conversationId,
        accountId: tenant.accountId,
        inboxId: tenant.inboxId,
        currentMessageId: payload.id,
      })
    ) {
      wasHandedOff = false
    }
    const outcome = triage(rawQuestion)
    let documentAssistance = Boolean(executionContext && isOwnDocumentReview(rawQuestion, outcome, conversationContext.labels, conversationContext.documentAssistanceActive))
    const question = redactConversationText(rawQuestion)
    const handoff = async (reason: string, detail?: string, draft?: string, learningSources?: SupportBrainAnswer['learningSources'], notify = true) => {
      await this.dependencies.autoSend.blockConversation({
        tenantKey: tenant.key,
        conversationId,
        reason: 'agent_handoff',
      })
      console.log(
        JSON.stringify({
          event: 'agent_handoff',
          reason,
          category: outcome.category,
          priority: outcome.priority,
          tenant: tenant.key,
          conversationId,
          ...(detail ? { detail } : {}),
        }),
      )
      await this.escalate({
        tenant,
        productTenant: supportRoute.tenant,
        conversationId,
        deliveryId: payload.id,
        outcome,
        reason,
        detail,
        isFinalAttempt,
        draft,
        learningSources,
        notifyCustomer: notify && !wasHandedOff && !crossProduct && !documentAssistance,
        canNotifyCustomer: async () => {
          if (!this.dependencies.context.loadCurrentSource) return true
          const current = await this.dependencies.context.loadCurrentSource({ accountId: tenant.accountId, inboxId: tenant.inboxId, conversationDisplayId: conversationId, currentMessageId: payload.id, tenant: supportRoute.tenant, channel: supportRoute.channel })
          return Boolean(current && JSON.stringify(current.executionContext) === JSON.stringify(executionContext) && current.content.trim() === rawQuestion)
        },
      })
      await this.dependencies.state.completeHandoff(tenant.key, payload.id, conversationId)
    }

    // Voice is an unconfirmed customer source. It can only create a human
    // review draft; it never reaches the brain's action/tool path or auto-send.
    if (supportRoute.channel === 'whatsapp' && hasAudioAttachment) {
      const bytes = audioAttachment ? await this.dependencies.chatwoot.loadVoiceAttachment?.(
        tenant, conversationId, payload.id, audioAttachment,
      ) : undefined
      const transcript = bytes && audioAttachment && this.dependencies.audio && executionContext
        ? await this.dependencies.audio.transcribe({
            bytes,
            requestId: `audio:${supportBrainRequestId(this.dependencies.pseudonymizationKey, tenant.accountId, payload.id)}:${audioAttachment.id}`,
            accountId: tenant.accountId, inboxId: tenant.inboxId,
            conversationId, sourceMessageId: payload.id, attachmentId: audioAttachment.id,
          }) : undefined
      const current = await this.dependencies.context.loadCurrentSource?.({
        accountId: tenant.accountId, inboxId: tenant.inboxId,
        conversationDisplayId: conversationId, currentMessageId: payload.id,
        tenant: supportRoute.tenant, channel: supportRoute.channel,
      })
      if (!current || JSON.stringify(current.executionContext) !== JSON.stringify(executionContext) ||
        current.content.trim() !== rawQuestion ||
        (current.hasAudioAttachment === true || Boolean(current.audioAttachment)) !== hasAudioAttachment ||
        current.audioAttachment?.id !== audioAttachment?.id ||
        current.audioAttachment?.byteSize !== audioAttachment?.byteSize) {
        await this.completeSuperseded(tenant.key, payload.id)
        return
      }
      const caption = rawQuestion ? `\n\nBegleittext (ungeprüft): „${redactConversationText(rawQuestion)}“` : ''
      const draft = transcript
        ? `Sprachnachricht vom Kunden (Chatwoot-Nachricht ${payload.id}, Anhang ${audioAttachment?.id}) wurde automatisch transkribiert. Das Transkript ist unbestätigt und kann Fehler enthalten:\n\n„${transcript}“${caption}\n\nBitte Inhalt mit dem Kunden bestätigen, bevor eine sensible Aktion erfolgt.`
        : `Sprachnachricht vom Kunden (Chatwoot-Nachricht ${payload.id}) konnte nicht sicher transkribiert werden.${caption}\n\nBitte Audio manuell prüfen und den Inhalt vor sensiblen Aktionen bestätigen.`
      await handoff(transcript ? 'audio_confirmation_required' : 'audio_unavailable', undefined, draft, undefined, false)
      return
    }

    if (!question) {
      await handoff('empty_message', undefined, ATTACHMENT_REVIEW_DRAFT)
      return
    }
    // Human-Lock, bestehende Uebergabe und sensible Labels sperren nur den
    // oeffentlichen Auto-Send. Interne Composer-Entwuerfe laufen weiter.
    const humanInConversation =
      conversationContext.humanEverReplied ||
      conversationContext.turns.some((turn) => turn.role === 'human')
    const humanOwned = humanInConversation || wasHandedOff || humanOnlyLabel
    if (humanInConversation || humanOnlyLabel || wasHandedOff) {
      await this.dependencies.autoSend.blockConversation({
        tenantKey: tenant.key,
        conversationId,
        reason: humanInConversation
          ? 'human_reply'
          : humanOnlyLabel
            ? 'human_only_label'
            : 'agent_handoff',
      })
    }
    if (outcome.humanOnly && !humanOwned && !documentAssistance) {
      await handoff(
        `triage_${outcome.category}`,
        undefined,
        outcome.customerAck,
      )
      return
    }
    const reviewOnly = crossProduct || humanOwned || (outcome.category === 'beratung' && !documentAssistance)
    const directReply = reviewOnly ? undefined : directSupportReply(question)
    let answer: SupportBrainAnswer
    if (directReply) {
      answer = {
        action: 'answer',
        text: directReply,
        confidence: 1,
        sources: [],
        safeToAutoSend: true,
        reason: 'deterministic_presence',
      }
    } else {
      try {
        answer = await this.dependencies.brain.answer({
          requestId: supportBrainRequestId(
            this.dependencies.pseudonymizationKey,
            tenant.accountId,
            payload.id,
          ),
          ...(executionContext ? { executionContext } : {}),
          question,
          questionReceivedAt: payload.created_at,
          history: conversationContext.turns.map(
            (turn): SupportBrainHistoryTurn => ({
              role: turn.role === 'customer' ? 'user' : 'agent',
              text: turn.text,
            }),
          ),
          tenant: supportRoute.tenant,
          channel: supportRoute.channel,
          ...(conversationContext.contactEmail || conversationContext.contactName || conversationContext.contactPhone
            ? { contact: { email: conversationContext.contactEmail, name: conversationContext.contactName, phone: conversationContext.contactPhone } }
            : {}),
          // A source-bound read can run in a draft; the kill switch must still
          // forbid calendar writes even though the verified source is present.
          ...(reviewOnly || (executionContext && !this.dependencies.autoSendEnabled) ? { reviewOnly: true } : {}),
        })
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'agent_brain_failed',
            tenant: tenant.key,
            conversationId,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        // Ein interner Review-Pfad darf den Composer bei einem Gehirnausfall
        // nicht wieder leeren. Der neutrale Ack bleibt ausschließlich intern.
        if (reviewOnly) {
          answer = {
            action: 'answer',
            text: outcome.customerAck,
            confidence: 0,
            sources: [],
            safeToAutoSend: false,
            reason: 'brain_error_review',
          }
        } else {
          await handoff(
            'brain_error',
            error instanceof Error ? error.message : undefined,
            outcome.humanOnly || !this.dependencies.autoSendEnabled
              ? outcome.customerAck
              : undefined,
          )
          return
        }
      }
    }

    documentAssistance ||= answer.reason?.startsWith('document_assistance:') === true
    if (answer.action === 'handoff' && !humanOwned && !documentAssistance) {
      await handoff('brain_handoff', answer.reason, answer.text, answer.learningSources)
      return
    }

    const binding = executionContext ? { requestId: supportBrainRequestId(this.dependencies.pseudonymizationKey, tenant.accountId, payload.id), sourceMessageId: executionContext.sourceMessageId, reviewOnly: reviewOnly || !this.dependencies.autoSendEnabled } : undefined
    const documentApproved = documentAssistance && hasBoundAutomation(answer, binding) && (answer.automation?.kind === 'document_verification' || answer.automation?.kind === 'document_access')
    const verdict: AutoSendVerdict | 'manual_review' = reviewOnly || (documentAssistance && !documentApproved)
      ? 'manual_review'
      : autoSendDecision({
          enabled: this.dependencies.autoSendEnabled,
          humanInConversation: humanOwned,
          answer,
          binding,
        })
    if (verdict === 'auto_send') {
      // Ein Fehler der Chatwoot-API laeuft hier bewusst in den Job-Retry und
      // nicht in den Entwurfspfad: bereits gesendete Nachrichten sind ueber den
      // Delivery-Marker idempotent, ein zweiter Weg waere es nicht.
      await this.autoAnswer({
        tenant,
        productTenant: supportRoute.tenant,
        productChannel: supportRoute.channel,
        conversationId,
        deliveryId: payload.id,
        question,
        answer,
        contactHash: conversationContext.contactHash,
        previousAgentDraft: conversationContext.previousAgentDraft,
        executionContext,
      })
      return
    }

    const retainAutomation = Boolean(executionContext && this.dependencies.autoSendEnabled && !crossProduct && !humanOwned && (!outcome.humanOnly || documentAssistance) && !reviewOnly && answer.action !== 'handoff')
    let written = false
    try {
      written = await this.prepareDraft({
        tenant,
        productTenant: supportRoute.tenant,
        conversationId,
        deliveryId: payload.id,
        answer,
        verdict,
        documentAssistance,
        retainAutomation,
        labels:
          reviewOnly && outcome.category === 'beratung' && !documentAssistance
            ? outcome.labels
            : undefined,
        previousAgentDraft: conversationContext.previousAgentDraft,
      })
    } catch (error) {
      if (!(input.isFinalAttempt ?? true)) throw error
      await handoff(
        'draft_error',
        error instanceof Error ? error.message : undefined,
        !this.dependencies.autoSendEnabled ? answer.text : undefined,
      )
      return
    }
    if (retainAutomation && written) await this.completeSuperseded(tenant.key, payload.id)
    else await this.dependencies.state.completeHandoff(tenant.key, payload.id, conversationId)
  }

  /**
   * Eine atomare Reservierung beansprucht genau einen Slot. Erst danach wird
   * die live Chatwoot-/AgentState-Autorisierung direkt vor dem Send erneuert.
   */
  private async completeSuperseded(tenant: TenantKey, messageId: number): Promise<void> {
    if (!this.dependencies.state.completeWithoutReply) throw new Error('Source changed; terminal completion unavailable')
    await this.dependencies.state.completeWithoutReply(tenant, messageId)
  }

  private async autoAnswer(input: {
    tenant: TenantConfig
    productTenant: TenantKey
    productChannel: SupportRoute['channel']
    conversationId: number
    deliveryId: number
    question: string
    answer: SupportBrainAnswer
    contactHash?: string
    executionContext?: SupportExecutionContext
    previousAgentDraft?: string
  }): Promise<void> {
    const { tenant, conversationId, deliveryId, answer } = input
    const reservation = await this.dependencies.autoSend.reserve(
      {
        tenantKey: tenant.key,
        conversationId,
        messageId: deliveryId,
        contactHash: input.contactHash,
        questionHash: questionFingerprint(
          this.dependencies.pseudonymizationKey,
          tenant.key,
          input.question,
        ),
        confidence: answer.confidence,
        sourceIds: answer.reason?.startsWith('document_assistance:') ? [] : answer.sources.map((source) => source.url),
        ...(answer.reason?.startsWith('document_assistance:') ? { sensitive: true } : {}),
        sentText: answer.text,
      },
      this.dependencies.autoSendLimits,
    )
    if (!reservation.reserved) {
      await this.prepareDraft({
        tenant,
        productTenant: input.productTenant,
        conversationId,
        deliveryId,
        answer,
        verdict: reservation.verdict,
        previousAgentDraft: input.previousAgentDraft,
      })
      await this.dependencies.state.completeHandoff(tenant.key, deliveryId, conversationId)
      return
    }

    if (reservation.entry.sensitive || answer.reason?.startsWith('document_assistance:')) {
      // Persist the privacy marker before any public effect. All live ownership,
      // routing and source checks below run after this awaited external write.
      await this.dependencies.chatwoot.sendPrivateNote(tenant, conversationId, 'Private Dokumenthilfe – vom Lernen ausgeschlossen.', deliveryId, 'document_assistance_note')
    }

    const liveContext = await this.dependencies.context.loadContext({
      accountId: tenant.accountId,
      inboxId: tenant.inboxId,
      conversationDisplayId: conversationId,
      currentMessageId: deliveryId,
    })
    if (!liveContext) throw new Error('Chatwoot conversation context is unavailable before send')
    const liveRoute = this.supportRoute(tenant, liveContext)
    if (
      !liveRoute ||
      liveRoute.tenant !== input.productTenant ||
      liveRoute.channel !== input.productChannel
    ) {
      throw new Error('Chatwoot support routing changed before send')
    }
    const liveHandedOff = await this.dependencies.state.isHandedOff(
      tenant.key,
      conversationId,
    )
    const liveHuman =
      liveContext.humanEverReplied ||
      liveContext.turns.some((turn) => turn.role === 'human')
    const liveHumanOnlyLabel = hasHumanOnlyLabel(liveContext.labels)
    if (liveHuman || liveHumanOnlyLabel || liveHandedOff) {
      await this.dependencies.autoSend.blockConversation({
        tenantKey: tenant.key,
        conversationId,
        reason: liveHuman
          ? 'human_reply'
          : liveHumanOnlyLabel
            ? 'human_only_label'
            : 'agent_handoff',
      })
    }
    const liveVerdict = autoSendDecision({
      enabled: this.dependencies.autoSendEnabled,
      humanInConversation: liveHuman || liveHumanOnlyLabel || liveHandedOff,
      answer,
      binding: input.executionContext ? { requestId: supportBrainRequestId(this.dependencies.pseudonymizationKey, tenant.accountId, deliveryId), sourceMessageId: input.executionContext.sourceMessageId, reviewOnly: false } : undefined,
    })
    if (liveVerdict !== 'auto_send') {
      await this.prepareDraft({
        tenant,
        productTenant: input.productTenant,
        conversationId,
        deliveryId,
        answer,
        verdict: liveVerdict,
        previousAgentDraft: liveContext.previousAgentDraft,
      })
      await this.dependencies.state.completeHandoff(tenant.key, deliveryId, conversationId)
      return
    }

    if (this.dependencies.context.loadCurrentSource) {
      const current = await this.dependencies.context.loadCurrentSource({ accountId: tenant.accountId, inboxId: tenant.inboxId, conversationDisplayId: conversationId, currentMessageId: deliveryId, tenant: input.productTenant, channel: input.productChannel })
      if (!current || JSON.stringify(current.executionContext) !== JSON.stringify(input.executionContext) || redactConversationText(current.content.trim()) !== input.question) {
        await this.completeSuperseded(tenant.key, deliveryId)
        return
      }
    }

    const reservedEntry = reservation.entry
    const usage = reservation.usage
    await this.dependencies.state.markSending(tenant.key, deliveryId)
    await this.dependencies.chatwoot.sendMessage(
      tenant,
      conversationId,
      reservedEntry.sentText,
      deliveryId,
      'answer',
    )
    await this.dependencies.autoSend.markSent(tenant.key, deliveryId)
    const limits = this.dependencies.autoSendLimits
    const deterministic = answer.reason === 'deterministic_presence'
    const sourceLine = deterministic
      ? 'Quellen: nicht erforderlich (deterministische Präsenzantwort)'
      : `Quellen: ${reservedEntry.sourceIds.join(', ') || 'keine'}`
    const approval = deterministic
      ? 'Freigabe: deterministische Präsenzantwort'
      : `Freigabe: Gehirn safeToAutoSend${answer.reason ? ` (${answer.reason})` : ''}`
    await this.dependencies.chatwoot.sendPrivateNote(
      tenant,
      conversationId,
      [
        `KI-Antwort automatisch gesendet · Confidence ${reservedEntry.confidence.toFixed(2)}`,
        sourceLine,
        approval +
          ` · Konversation ${usage.conversationCount + 1}/${limits.maxPerConversation}` +
          ` · Kontakt ${usage.contactCountLastHour + 1}/${limits.maxPerContactPerHour} pro Stunde`,
        'Antworte einfach selbst, wenn etwas fehlt — danach sendet die KI in diesem Gespräch nichts mehr automatisch.',
      ].join('\n'),
      deliveryId,
      'answer_sources',
    )
    await this.dependencies.chatwoot.addLabels(tenant, conversationId, ['ki-antwort'])
    await this.dependencies.state.completeReply(tenant.key, deliveryId)
    console.log(
      JSON.stringify({
        event: 'agent_auto_answer_sent',
        tenant: tenant.key,
        conversationId,
        confidence: reservedEntry.confidence,
        sources: reservedEntry.sourceIds.length,
      }),
    )
  }

  private async prepareDraft(input: {
    tenant: TenantConfig
    productTenant: TenantKey
    conversationId: number
    deliveryId: number
    answer: SupportBrainAnswer
    verdict: AutoSendVerdict | 'manual_review'
    labels?: readonly string[]
    documentAssistance?: boolean
    retainAutomation?: boolean
    previousAgentDraft?: string
  }): Promise<boolean> {
    const { tenant, conversationId, deliveryId, answer, verdict } = input
    const draftWrite = input.previousAgentDraft
      ? await this.dependencies.chatwoot.saveDraft(
          tenant,
          conversationId,
          answer.text,
          input.previousAgentDraft,
        )
      : await this.dependencies.chatwoot.saveDraft(
          tenant,
          conversationId,
          answer.text,
        )
    await this.dependencies.chatwoot.addLabels(tenant, conversationId, [
      'ki-entwurf',
      ...(input.labels ?? []),
    ])
    const sourceNote =
      answer.sources.length > 0
        ? `\nQuellen: ${brainSources(answer)}`
        : '\nGrundlage: PII-redigierter Gesprächsverlauf; keine Sachbehauptung.'
    const draftNote = draftWrite.written
      ? `KI-Antwortentwurf wartet auf menschliche Freigabe (${verdict}).\n\nAntwortvorschlag:\n${draftWrite.message}${sourceNote}`
      : `KI-Vorschlag wurde nicht in den Composer übernommen, weil dort ein menschlich bearbeiteter Entwurf liegt.\n\nVorschlag zur Referenz:\n${answer.text}${sourceNote}`
    const noteContent = draftNote + privateLearningReferences(answer, input.productTenant)
    await this.dependencies.chatwoot.sendPrivateNote(
      tenant,
      conversationId,
      noteContent,
      deliveryId,
      input.documentAssistance || answer.reason?.startsWith('document_assistance:') ? 'document_assistance_note' : answer.action === 'clarify' ? 'clarify_draft_note' : 'draft_note',
    )
    if (!input.retainAutomation || !draftWrite.written) {
      await this.dependencies.chatwoot.assign(tenant, conversationId, tenant.handoffAssigneeId)
      await this.dependencies.chatwoot.handoff(tenant, conversationId)
    }
    console.log(
      JSON.stringify({
        event: 'agent_draft_ready',
        action: answer.action,
        verdict,
        tenant: tenant.key,
        conversationId,
        draftWritten: draftWrite.written,
      }),
    )
    return draftWrite.written
  }

  /**
   * Alle Schritte werden versucht, damit ein einzelner 4xx die Uebergabe
   * nicht blockiert. Ein Gehirn-Handoff legt zusaetzlich einen editierbaren
   * Entwurf ab; nach der ersten Uebergabe wird der Kunde nicht erneut mit
   * demselben Hinweis angeschrieben.
   */
  private async escalate(input: {
    tenant: TenantConfig
    productTenant: TenantKey
    conversationId: number
    deliveryId: number
    outcome: TriageOutcome
    reason: string
    detail?: string
    isFinalAttempt: boolean
    draft?: string
    learningSources?: SupportBrainAnswer['learningSources']
    notifyCustomer?: boolean
    canNotifyCustomer?: () => Promise<boolean>
  }): Promise<void> {
    const { tenant, conversationId, deliveryId, outcome } = input
    const { chatwoot } = this.dependencies
    const failures: Array<{ error: Error; essential: boolean; step: string }> = []
    const run = async (
      step: string,
      essential: boolean,
      action: () => Promise<void>,
    ) => {
      try {
        await action()
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        failures.push({ error: failure, essential, step })
        console.error(
          JSON.stringify({
            event: 'agent_escalation_step_failed',
            step,
            essential,
            tenant: tenant.key,
            conversationId,
            error: failure.message,
          }),
        )
      }
    }
    const draft = input.draft
    let writtenDraft: string | undefined
    let humanDraftPreserved = false
    if (draft) {
      await run('draft', true, async () => {
        const result = await chatwoot.saveDraft(
          tenant,
          conversationId,
          draft,
        )
        if (result.written) writtenDraft = result.message
        else humanDraftPreserved = true
      })
    }
    const labels = writtenDraft
      ? [...new Set([...outcome.labels, 'ki-entwurf'])]
      : outcome.labels
    const handoffContent = handoffNote({
      outcome,
      reason: input.reason,
      detail: input.detail,
    })
    const draftSourceNote = input.reason.startsWith('audio_')
      ? 'Grundlage: unbestätigtes, quellengebundenes Audio-Transkript; vor sensibler Aktion bestätigen.'
      : 'Grundlage: PII-redigierter Gesprächsverlauf; keine Sachbehauptung.'
    const draftNote = writtenDraft
      ? `${handoffContent}\n\nAntwortvorschlag:\n${writtenDraft}\n${draftSourceNote}`
      : draft
        ? `${handoffContent}\n\n${humanDraftPreserved ? 'Im Composer liegt ein menschlich bearbeiteter Entwurf.\n\n' : ''}Vorschlag zur Referenz:\n${draft}`
        : handoffContent
    const noteContent = draftNote + privateLearningReferences(input, input.productTenant)

    await run('priority', false, () =>
      chatwoot.setPriority(tenant, conversationId, outcome.priority),
    )
    await run('labels', false, () =>
      chatwoot.addLabels(tenant, conversationId, labels),
    )
    await run('note', true, () =>
      chatwoot.sendPrivateNote(
        tenant,
        conversationId,
        noteContent,
        deliveryId,
        'handoff_note',
      ),
    )
    await run('assign', !this.dependencies.autoSendEnabled, () =>
      chatwoot.assign(tenant, conversationId, tenant.handoffAssigneeId),
    )
    await run('open', true, () => chatwoot.handoff(tenant, conversationId))
    // Der Review-Schalter gilt auch fuer Uebergabe- und Fehlerbestaetigungen.
    if (this.dependencies.autoSendEnabled && input.notifyCustomer !== false) {
      await run('customer_ack', true, async () => {
        if (input.canNotifyCustomer && !await input.canNotifyCustomer()) return
        await chatwoot.sendMessage(
          tenant,
          conversationId,
          outcome.customerAck,
          deliveryId,
          'handoff_ack',
        )
      })
    }

    const essentialFailures = failures.filter(({ essential }) => essential)
    if (essentialFailures.length > 0 || (failures.length > 0 && !input.isFinalAttempt)) {
      throw new AggregateError(
        failures.map(({ error }) => error),
        'Chatwoot escalation is incomplete',
      )
    }
    if (failures.length > 0) {
      console.error(
        JSON.stringify({
          event: 'agent_escalation_degraded',
          tenant: tenant.key,
          conversationId,
          failedSteps: failures.map(({ step }) => step),
        }),
      )
    }
  }

  private supportRoute(
    tenant: TenantConfig,
    context: ConversationContext,
  ): SupportRoute | undefined {
    return resolveSupportRoute(context.supportRouting, {
      tenant: tenant.key,
      channel: this.dependencies.whatsappInboxIds.has(tenant.inboxId)
        ? 'whatsapp'
        : 'web',
    })
  }
}

function hasHumanOnlyLabel(labels: readonly string[]): boolean {
  return labels.some((label) => HUMAN_ONLY_LABELS[label.trim().toLowerCase()] === true)
}

/** Belegte Quellen fuer die interne Notiz; ohne Beleg bleibt die Zeile leer. */
function brainSources(answer: SupportBrainAnswer): string {
  const references: string[] = []
  for (const source of answer.sources) {
    const reference = `${source.title} (${source.url})`
    if (!references.includes(reference)) references.push(reference)
  }
  return references.join(', ') || 'keine'
}
