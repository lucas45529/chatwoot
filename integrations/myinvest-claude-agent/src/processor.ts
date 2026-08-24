import type { ChatwootPort } from './chatwoot-client.js'
import type { ClaudeAnswer, ClaudePort } from './claude.js'
import type { TenantConfig } from './config.js'
import type { ChatwootWebhookPayload, KnowledgeHit } from './domain.js'
import type { KnowledgeRepository } from './knowledge/repository.js'
import type { AgentState } from './state.js'
import { handoffNote, triage, type TriageOutcome } from './triage.js'

export class MessageProcessor {
  constructor(
    private readonly dependencies: {
      knowledge: KnowledgeRepository
      claude: ClaudePort
      chatwoot: ChatwootPort
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
    const { tenant, payload } = input
    const conversationId = payload.conversation.id
    if (await this.dependencies.state.isHandedOff(tenant.key, conversationId)) return

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
        isFinalAttempt: input.isFinalAttempt ?? true,
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

    let sources: KnowledgeHit[]
    try {
      sources = await this.dependencies.knowledge.search(
        tenant.key,
        question,
        this.dependencies.maxSources,
        this.dependencies.minRetrievalScore,
      )
    } catch (error) {
      await handoff('retrieval_error', error instanceof Error ? error.message : undefined)
      return
    }

    if (!sources[0] || sources[0].score < this.dependencies.minRetrievalScore) {
      // Frage mitschreiben (gekuerzt): die Retrieval-Miss-Reports bauen daraus
      // die Liste fehlender Wissensartikel.
      const excerpt = question.slice(0, 120).replace(/\s+/g, ' ')
      await handoff(
        'retrieval_miss',
        `top_score=${sources[0]?.score ?? 'none'} question=${JSON.stringify(excerpt)}`,
      )
      return
    }

    let answer: ClaudeAnswer
    try {
      answer = await this.dependencies.claude.answer({
        tenantKey: tenant.key,
        question,
        sources,
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

    const sourceList = citedSources(sources, answer.sourceIds)
    await this.dependencies.state.markSending(tenant.key, payload.id)
    // Beide Nachrichten sind ueber deliveryId + kind idempotent. Scheitert
    // danach der Ledger, kann BullMQ neu versuchen, ohne doppelt zu senden.
    await this.dependencies.chatwoot.sendMessage(
      tenant,
      conversationId,
      answer.text,
      payload.id,
      'answer',
    )
    await this.dependencies.chatwoot.sendPrivateNote(
      tenant,
      conversationId,
      `KI-Antwort gesendet.\nQuellen: ${sourceList}`,
      payload.id,
      'answer_sources',
    )
    await this.dependencies.state.completeReply(tenant.key, payload.id)
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
