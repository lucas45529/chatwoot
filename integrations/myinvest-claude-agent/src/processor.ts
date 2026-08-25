import {
  autoSendDecision,
  questionFingerprint,
  type AutoSendLimits,
  type AutoSendLog,
  type AutoSendUsage,
  type AutoSendVerdict,
} from './auto-send.js'
import type { ChatwootPort } from './chatwoot-client.js'
import type { ChatwootConversationContextStore } from './chatwoot-delivery-repository.js'
import type { TenantConfig } from './config.js'
import type { ChatwootWebhookPayload } from './domain.js'
import type { AgentState } from './state.js'
import type {
  SupportBrainAnswer,
  SupportBrainHistoryTurn,
  SupportBrainPort,
} from './support-brain.js'
import { directSupportReply, handoffNote, triage, type TriageOutcome } from './triage.js'

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

export class MessageProcessor {
  constructor(
    private readonly dependencies: {
      brain: SupportBrainPort
      chatwoot: ChatwootPort
      context: ChatwootConversationContextStore
      state: AgentState
      autoSend: AutoSendLog
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
    const { tenant, payload, isFinalAttempt = true } = input
    const conversationId = payload.conversation.id
    const conversationContext = await this.dependencies.context.loadContext({
      accountId: tenant.accountId,
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
    const wasHandedOff = await this.dependencies.state.isHandedOff(
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

    const question = payload.content.trim()
    const outcome = triage(question)
    const handoff = async (reason: string, detail?: string, draft?: string) => {
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
        conversationId,
        deliveryId: payload.id,
        outcome,
        reason,
        detail,
        isFinalAttempt,
        draft,
        notifyCustomer: !wasHandedOff,
      })
      await this.dependencies.state.completeHandoff(tenant.key, payload.id, conversationId)
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
    if (humanInConversation || humanOnlyLabel) {
      await this.dependencies.autoSend.blockConversation({
        tenantKey: tenant.key,
        conversationId,
        reason: humanInConversation ? 'human_reply' : 'human_only_label',
      })
    }
    if (outcome.humanOnly && !humanOwned) {
      await handoff(
        `triage_${outcome.category}`,
        undefined,
        outcome.customerAck,
      )
      return
    }
    const reviewOnly = humanOwned || outcome.category === 'beratung'
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
          question,
          history: conversationContext.turns.map(
            (turn): SupportBrainHistoryTurn => ({
              role: turn.role === 'customer' ? 'user' : 'agent',
              text: turn.text,
            }),
          ),
          tenant: tenant.key,
          channel:
            payload.inboxId !== undefined &&
            this.dependencies.whatsappInboxIds.has(payload.inboxId)
              ? 'whatsapp'
              : 'web',
          contact: conversationContext.contactEmail
            ? { email: conversationContext.contactEmail }
            : undefined,
          reviewOnly: reviewOnly || undefined,
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
            outcome.humanOnly ? outcome.customerAck : undefined,
          )
          return
        }
      }
    }


    if (answer.action === 'handoff' && !humanOwned) {
      await handoff('brain_handoff', answer.reason, answer.text)
      return
    }

    const usage = await this.dependencies.autoSend.usage({
      tenantKey: tenant.key,
      conversationId,
      messageId: payload.id,
      contactHash: conversationContext.contactHash,
    })
    const verdict = autoSendDecision({
      enabled: this.dependencies.autoSendEnabled,
      humanInConversation: humanOwned,
      answer,
      usage,
      limits: this.dependencies.autoSendLimits,
    })
    if (verdict === 'auto_send') {
      // Ein Fehler der Chatwoot-API laeuft hier bewusst in den Job-Retry und
      // nicht in den Entwurfspfad: bereits gesendete Nachrichten sind ueber den
      // Delivery-Marker idempotent, ein zweiter Weg waere es nicht.
      await this.autoAnswer({
        tenant,
        conversationId,
        deliveryId: payload.id,
        question,
        answer,
        usage,
        contactHash: conversationContext.contactHash,
      })
      return
    }

    try {
      await this.prepareDraft({
        tenant,
        conversationId,
        deliveryId: payload.id,
        answer,
        verdict,
        labels:
          reviewOnly && outcome.category === 'beratung'
            ? outcome.labels
            : undefined,
        previousAgentDraft: conversationContext.previousAgentDraft,
      })
    } catch (error) {
      if (!(input.isFinalAttempt ?? true)) throw error
      await handoff('draft_error', error instanceof Error ? error.message : undefined)
      return
    }
    await this.dependencies.state.completeHandoff(tenant.key, payload.id, conversationId)
  }

  /**
   * Die automatisch gesendete Antwort. Die Audit-Zeile wird bewusst vor dem
   * Senden geschrieben: bricht der Sendeversuch danach ab, ist die Obergrenze
   * lieber zu streng als zu weit.
   */
  private async autoAnswer(input: {
    tenant: TenantConfig
    conversationId: number
    deliveryId: number
    question: string
    answer: SupportBrainAnswer
    usage: AutoSendUsage
    contactHash?: string
  }): Promise<void> {
    const { tenant, conversationId, deliveryId, answer, usage } = input
    await this.dependencies.state.markSending(tenant.key, deliveryId)
    await this.dependencies.autoSend.record({
      tenantKey: tenant.key,
      conversationId,
      messageId: deliveryId,
      contactHash: input.contactHash,
      questionHash: questionFingerprint(tenant.key, input.question),
      confidence: answer.confidence,
      sourceIds: answer.sources.map((source) => source.url),
      sentText: answer.text,
    })
    await this.dependencies.chatwoot.sendMessage(
      tenant,
      conversationId,
      answer.text,
      deliveryId,
      'answer',
    )
    await this.dependencies.autoSend.markSent(tenant.key, deliveryId)
    const limits = this.dependencies.autoSendLimits
    const deterministic = answer.reason === 'deterministic_presence'
    const sourceLine = deterministic
      ? 'Quellen: nicht erforderlich (deterministische Präsenzantwort)'
      : `Quellen: ${brainSources(answer)}`
    const approval = deterministic
      ? 'Freigabe: deterministische Präsenzantwort'
      : `Freigabe: Gehirn safeToAutoSend${answer.reason ? ` (${answer.reason})` : ''}`
    await this.dependencies.chatwoot.sendPrivateNote(
      tenant,
      conversationId,
      [
        `KI-Antwort automatisch gesendet · Confidence ${answer.confidence.toFixed(2)}`,
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
        confidence: answer.confidence,
        sources: answer.sources.length,
      }),
    )
  }

  private async prepareDraft(input: {
    tenant: TenantConfig
    conversationId: number
    deliveryId: number
    answer: SupportBrainAnswer
    verdict: AutoSendVerdict
    labels?: readonly string[]
    previousAgentDraft?: string
  }): Promise<void> {
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
    const noteContent = draftWrite.written
      ? `KI-Antwortentwurf wartet auf menschliche Freigabe (${verdict}).\n\nAntwortvorschlag:\n${draftWrite.message}${sourceNote}`
      : `KI-Vorschlag wurde nicht in den Composer übernommen, weil dort ein menschlich bearbeiteter Entwurf liegt.\n\nVorschlag zur Referenz:\n${answer.text}${sourceNote}`
    await this.dependencies.chatwoot.sendPrivateNote(
      tenant,
      conversationId,
      noteContent,
      deliveryId,
      answer.action === 'clarify' ? 'clarify_draft_note' : 'draft_note',
    )
    await this.dependencies.chatwoot.assign(
      tenant,
      conversationId,
      tenant.handoffAssigneeId,
    )
    await this.dependencies.chatwoot.handoff(tenant, conversationId)
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
  }

  /**
   * Alle Schritte werden versucht, damit ein einzelner 4xx die Uebergabe
   * nicht blockiert. Ein Gehirn-Handoff legt zusaetzlich einen editierbaren
   * Entwurf ab; nach der ersten Uebergabe wird der Kunde nicht erneut mit
   * demselben Hinweis angeschrieben.
   */
  private async escalate(input: {
    tenant: TenantConfig
    conversationId: number
    deliveryId: number
    outcome: TriageOutcome
    reason: string
    detail?: string
    isFinalAttempt: boolean
    draft?: string
    notifyCustomer?: boolean
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
    if (draft) {
      await run('draft', true, async () => {
        const result = await chatwoot.saveDraft(
          tenant,
          conversationId,
          draft,
        )
        if (result.written) writtenDraft = result.message
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
    const noteContent = writtenDraft
      ? `${handoffContent}\n\nAntwortvorschlag:\n${writtenDraft}\nGrundlage: PII-redigierter Gesprächsverlauf; keine Sachbehauptung.`
      : handoffContent

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
    await run('assign', false, () =>
      chatwoot.assign(tenant, conversationId, tenant.handoffAssigneeId),
    )
    await run('open', true, () => chatwoot.handoff(tenant, conversationId))
    if (input.notifyCustomer !== false) {
      await run('customer_ack', true, () =>
        chatwoot.sendMessage(
          tenant,
          conversationId,
          outcome.customerAck,
          deliveryId,
          'handoff_ack',
        ),
      )
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
