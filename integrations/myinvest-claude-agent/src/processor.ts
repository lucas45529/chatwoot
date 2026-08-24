import type { ChatwootPort } from './chatwoot-client.js'
import type { ClaudePort } from './claude.js'
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
      /** Chatwoot-User, dem übergebene Gespräche zugewiesen werden. */
      handoffAssigneeId?: number
    },
  ) {}

  async process(input: {
    tenant: TenantConfig
    payload: ChatwootWebhookPayload
  }): Promise<void> {
    const { tenant, payload } = input
    const conversationId = payload.conversation.id
    if (await this.dependencies.state.isHandedOff(tenant.key, conversationId)) return

    const delivery = await this.dependencies.state.beginDelivery(
      tenant.key,
      payload.id,
      conversationId,
      payload.created_at,
    )
    if (!delivery.acquired) {
      if (delivery.status === 'processing' || delivery.status === 'sending') {
        // Parallele Lieferung derselben Nachricht: die andere antwortet bereits,
        // deshalb hier nur öffnen und keine zweite Nachricht an den Kunden.
        await this.dependencies.chatwoot.handoff(tenant, conversationId)
        await this.dependencies.state.markHandedOff(tenant.key, conversationId)
        await this.dependencies.state.completeDelivery(tenant.key, payload.id, 'handed_off')
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
      await this.escalate({ tenant, conversationId, deliveryId: payload.id, outcome, reason, detail })
      await this.dependencies.state.markHandedOff(tenant.key, conversationId)
      await this.dependencies.state.completeDelivery(tenant.key, payload.id, 'handed_off')
    }

    if (!question || outcome.humanOnly) {
      await handoff(question ? `triage_${outcome.category}` : 'empty_message')
      return
    }

    try {
      const sources = await this.dependencies.knowledge.search(
        tenant.key,
        question,
        this.dependencies.maxSources,
        this.dependencies.minRetrievalScore,
      )
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
      const answer = await this.dependencies.claude.answer({
        tenantKey: tenant.key,
        question,
        sources,
      })
      const sourceList = citedSources(sources, answer.sourceIds)
      await this.dependencies.state.markSending(tenant.key, payload.id)
      // Der Kunde bekommt die Antwort ohne technische Quellenliste; der Beleg
      // geht als interne Notiz an das Team (nachvollziehbar, aber nicht im Chat).
      await this.dependencies.chatwoot.sendMessage(
        tenant,
        conversationId,
        answer.text,
        payload.id,
      )
      await this.step({ tenant, conversationId, step: 'answer_note' }, () =>
        this.dependencies.chatwoot.sendPrivateNote(
          tenant,
          conversationId,
          `KI-Antwort gesendet.\nQuellen: ${sourceList}`,
        ),
      )
      await this.dependencies.state.completeDelivery(tenant.key, payload.id, 'replied')
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
    }
  }

  /**
   * Sichtbare Übergabe an einen Menschen: Priorität, Labels, interne Notiz,
   * Zuweisung, Status offen — und eine Antwort an den Kunden, damit er nicht
   * im Leeren wartet. Jeder Schritt ist einzeln fehlertolerant, weil ein
   * fehlgeschlagener Nebenschritt (z. B. HTTP 404 auf toggle_status) den
   * Kunden-Hinweis nicht verhindern darf.
   */
  private async escalate(input: {
    tenant: TenantConfig
    conversationId: number
    deliveryId: number
    outcome: TriageOutcome
    reason: string
    detail?: string
  }): Promise<void> {
    const { tenant, conversationId, outcome } = input
    const context = { tenant, conversationId }
    const { chatwoot } = this.dependencies

    await this.step({ ...context, step: 'priority' }, () =>
      chatwoot.setPriority(tenant, conversationId, outcome.priority),
    )
    await this.step({ ...context, step: 'labels' }, () =>
      chatwoot.addLabels(tenant, conversationId, outcome.labels),
    )
    await this.step({ ...context, step: 'note' }, () =>
      chatwoot.sendPrivateNote(
        tenant,
        conversationId,
        handoffNote({ outcome, reason: input.reason, detail: input.detail }),
      ),
    )
    // Account-eigener Bearbeiter schlaegt den globalen Default: ein User ist nur
    // in seinen eigenen Chatwoot-Accounts zuweisbar.
    const assigneeId = tenant.handoffAssigneeId ?? this.dependencies.handoffAssigneeId
    if (assigneeId !== undefined) {
      await this.step({ ...context, step: 'assign' }, () =>
        chatwoot.assign(tenant, conversationId, assigneeId),
      )
    }
    await this.step({ ...context, step: 'open' }, () => chatwoot.handoff(tenant, conversationId))
    await this.step({ ...context, step: 'customer_ack' }, () =>
      chatwoot.sendMessage(tenant, conversationId, outcome.customerAck, input.deliveryId),
    )
  }

  private async step(
    context: { tenant: TenantConfig; conversationId: number; step: string },
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action()
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'agent_handoff_step_failed',
          step: context.step,
          tenant: context.tenant.key,
          conversationId: context.conversationId,
          error: error instanceof Error ? error.message : String(error),
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
