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
      console.log(
        JSON.stringify({
          event: 'agent_context_missing',
          tenant: tenant.key,
          conversationId,
        }),
      )
      return
    }
    const wasHandedOff = await this.dependencies.state.isHandedOff(
      tenant.key,
      conversationId,
    )
    if (hasHumanOnlyLabel(conversationContext.labels)) {
      console.log(
        JSON.stringify({
          event: 'agent_context_blocked_by_label',
          tenant: tenant.key,
          conversationId,
        }),
      )
      return
    }
    if (wasHandedOff) {
      if (!conversationContext.humanRepliedAfterBot) {
        console.log(
          JSON.stringify({
            event: 'agent_handoff_waiting_for_human',
            tenant: tenant.key,
            conversationId,
          }),
        )
        return
      }
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
    const handoff = async (reason: string, detail?: string) => {
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
      })
      await this.dependencies.state.completeHandoff(tenant.key, payload.id, conversationId)
    }

    if (!question) {
      await handoff('empty_message')
      return
    }
    if (outcome.humanOnly) {
      await handoff(`triage_${outcome.category}`)
      return
    }

    const directReply = directSupportReply(question)
    if (directReply) {
      await this.dependencies.state.markSending(tenant.key, payload.id)
      await this.dependencies.chatwoot.sendMessage(
        tenant,
        conversationId,
        directReply,
        payload.id,
        'answer',
      )
      await this.dependencies.state.completeReply(tenant.key, payload.id)
      console.log(
        JSON.stringify({
          event: 'agent_direct_reply',
          tenant: tenant.key,
          conversationId,
        }),
      )
      return
    }

    // Sobald ein Mensch in dieser Konversation geschrieben hat, ist Auto-Send
    // hier dauerhaft aus. Der Vermerk ueberlebt das 12-Nachrichten-Fenster des
    // Verlaufs, der Verlauf allein waere kein dauerhaftes Gedaechtnis.
    const humanInConversation = conversationContext.turns.some(
      (turn) => turn.role === 'human',
    )
    if (humanInConversation) {
      await this.dependencies.autoSend.blockConversation({
        tenantKey: tenant.key,
        conversationId,
        reason: 'human_reply',
      })
    }

    let answer: SupportBrainAnswer
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
      // Ausfall des Gehirns endet nie in Stille: der Kunde bekommt den
      // sichtbaren Uebergabe-Hinweis, das Team die Notiz.
      await handoff('brain_error', error instanceof Error ? error.message : undefined)
      return
    }

    if (answer.action === 'handoff') {
      await handoff('brain_handoff', answer.reason)
      return
    }

    const usage = await this.dependencies.autoSend.usage({
      tenantKey: tenant.key,
      conversationId,
      contactHash: conversationContext.contactHash,
    })
    const verdict = autoSendDecision({
      enabled: this.dependencies.autoSendEnabled,
      humanInConversation,
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
    const limits = this.dependencies.autoSendLimits
    await this.dependencies.chatwoot.sendPrivateNote(
      tenant,
      conversationId,
      [
        `KI-Antwort automatisch gesendet · Confidence ${answer.confidence.toFixed(2)}`,
        `Quellen: ${brainSources(answer)}`,
        `Freigabe: Gehirn safeToAutoSend${answer.reason ? ` (${answer.reason})` : ''}` +
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
  }): Promise<void> {
    const { tenant, conversationId, deliveryId, answer, verdict } = input
    await this.dependencies.chatwoot.saveDraft(tenant, conversationId, answer.text)
    await this.dependencies.chatwoot.addLabels(tenant, conversationId, ['ki-entwurf'])
    const sourceNote =
      answer.sources.length > 0
        ? `\nQuellen: ${brainSources(answer)}`
        : '\nGrundlage: PII-redigierter Gesprächsverlauf; keine Sachbehauptung.'
    await this.dependencies.chatwoot.sendPrivateNote(
      tenant,
      conversationId,
      `KI-Antwortentwurf wartet auf menschliche Freigabe (${verdict}).\n\nAntwortvorschlag:\n${answer.text}${sourceNote}`,
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
      }),
    )
  }

  /**
   * Alle Schritte werden versucht, damit ein einzelner 4xx den Kunden-Hinweis
   * nicht blockiert. Sichtbare Kernschritte (Notiz, Oeffnen, Kunden-Ack) sind
   * immer terminal-kritisch. Prioritaet/Labels/Zuweisung werden wiederholt; erst
   * im letzten Versuch darf der sichtbare Handoff ohne sie terminal werden.
   */
  private async escalate(input: {
    tenant: TenantConfig
    conversationId: number
    deliveryId: number
    outcome: TriageOutcome
    reason: string
    detail?: string
    isFinalAttempt: boolean
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

    await run('priority', false, () =>
      chatwoot.setPriority(tenant, conversationId, outcome.priority),
    )
    await run('labels', false, () =>
      chatwoot.addLabels(tenant, conversationId, outcome.labels),
    )
    await run('note', true, () =>
      chatwoot.sendPrivateNote(
        tenant,
        conversationId,
        handoffNote({ outcome, reason: input.reason, detail: input.detail }),
        deliveryId,
        'handoff_note',
      ),
    )
    await run('assign', false, () =>
      chatwoot.assign(tenant, conversationId, tenant.handoffAssigneeId),
    )
    await run('open', true, () => chatwoot.handoff(tenant, conversationId))
    await run('customer_ack', true, () =>
      chatwoot.sendMessage(
        tenant,
        conversationId,
        outcome.customerAck,
        deliveryId,
        'handoff_ack',
      ),
    )

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
