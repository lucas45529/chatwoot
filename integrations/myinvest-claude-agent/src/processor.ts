import type { ChatwootPort } from './chatwoot-client.js'
import type { ChatwootConversationContextStore } from './chatwoot-delivery-repository.js'
import type { ClaudeAnswer, ClaudePort } from './claude.js'
import type { TenantConfig } from './config.js'
import type { ChatwootWebhookPayload, ConversationContext, KnowledgeHit } from './domain.js'
import type { KnowledgeRepository } from './knowledge/repository.js'
import type { AgentState } from './state.js'
import { directSupportReply, handoffNote, triage, type TriageOutcome } from './triage.js'

const HUMAN_ONLY_LABELS: Record<string, true> = {
  sicherheitsverdacht: true,
  datenschutz: true,
  beschwerde: true,
  zahlung: true,
  termin: true,
  beratung: true,
  urgent: true,
  billing: true,
  'mensch-gewuenscht': true,
}
const IDENTITY_BOUND_REQUEST =
  /\b(?:leads?|versprochen|zugesagt|bank(?:wechsel|verbindung)|freischalt\w*)\b/iu

export class MessageProcessor {
  constructor(
    private readonly dependencies: {
      knowledge: KnowledgeRepository
      claude: ClaudePort
      chatwoot: ChatwootPort
      context: ChatwootConversationContextStore
      state: AgentState
      minRetrievalScore: number
      maxSources: number
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
      identity: payload.identity,
    })
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

    const searchQuery = contextualSearchQuery(question, conversationContext)
    let sources: KnowledgeHit[] = []
    const forceIdentityClarification =
      conversationContext.needsIdentityClarification &&
      IDENTITY_BOUND_REQUEST.test(searchQuery)
    if (!forceIdentityClarification) {
      try {
        sources = await this.dependencies.knowledge.search(
          tenant.key,
          searchQuery,
          this.dependencies.maxSources,
          this.dependencies.minRetrievalScore,
        )
      } catch (error) {
        await handoff('retrieval_error', error instanceof Error ? error.message : undefined)
        return
      }
    }

    // Unter der Schwelle gibt es kein belastbares Wissen: ohne Verlauf uebernimmt
    // ein Mensch, mit Verlauf entscheidet das Modell quellenlos (clarify).
    const retrievalMissed =
      !sources[0] || sources[0].score < this.dependencies.minRetrievalScore
    if (retrievalMissed) {
      if (conversationContext.turns.length === 0) {
        const excerpt = question.slice(0, 120).replace(/\s+/g, ' ')
        await handoff(
          'retrieval_miss',
          `top_score=${sources[0]?.score ?? 'none'} question=${JSON.stringify(excerpt)}`,
        )
        return
      }
      sources = []
    }

    let answer: ClaudeAnswer
    try {
      answer = await this.dependencies.claude.answer({
        tenantKey: tenant.key,
        question,
        sources,
        conversationContext,
      })
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'agent_answer_failed',
          tenant: tenant.key,
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      await handoff('answer_error', error instanceof Error ? error.message : undefined)
      return
    }

    try {
      await this.prepareDraft({
        tenant,
        conversationId,
        deliveryId: payload.id,
        answer,
        sources,
      })
    } catch (error) {
      if (!(input.isFinalAttempt ?? true)) throw error
      await handoff('draft_error', error instanceof Error ? error.message : undefined)
      return
    }
    await this.dependencies.state.completeHandoff(tenant.key, payload.id, conversationId)
  }

  private async prepareDraft(input: {
    tenant: TenantConfig
    conversationId: number
    deliveryId: number
    answer: ClaudeAnswer
    sources: readonly KnowledgeHit[]
  }): Promise<void> {
    const { tenant, conversationId, deliveryId, answer, sources } = input
    await this.dependencies.chatwoot.saveDraft(tenant, conversationId, answer.text)
    await this.dependencies.chatwoot.addLabels(tenant, conversationId, ['ki-entwurf'])
    const sourceNote =
      answer.sourceIds.length > 0
        ? `\nQuellen: ${citedSources(sources, answer.sourceIds)}`
        : '\nGrundlage: PII-redigierter Gesprächsverlauf; keine Sachbehauptung.'
    await this.dependencies.chatwoot.sendPrivateNote(
      tenant,
      conversationId,
      `KI-Antwortentwurf wartet auf menschliche Freigabe.\n\nAntwortvorschlag:\n${answer.text}${sourceNote}`,
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

function contextualSearchQuery(question: string, context: ConversationContext): string {
  const customerTurns = context.turns
    .filter((turn) => turn.role === 'customer')
    .slice(-3)
    .map((turn) => turn.text)
  return [...customerTurns, question].join('\n')
}

function citedSources(
  sources: readonly KnowledgeHit[],
  sourceIds: readonly string[],
): string {
  const references: string[] = []
  for (const source of sources) {
    if (!sourceIds.includes(source.sourceId)) continue
    const reference = sourceReference(source)
    if (!references.includes(reference)) references.push(reference)
  }
  return references.join(', ')
}

function sourceReference(source: KnowledgeHit): string {
  const url = source.metadata.url
  return typeof url === 'string' && /^https:\/\//.test(url)
    ? `${source.title} (${url})`
    : `${source.title} [${source.sourceId}]`
}
