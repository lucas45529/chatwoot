import type { TenantConfig } from './config.js'
import type { ChatwootDeliveryStore } from './chatwoot-delivery-repository.js'
import type { ConversationPriority } from './triage.js'

/** Nachrichten, die der Kunde im Chat sieht. */
export type PublicMessageKind = 'answer' | 'handoff_ack'
export type PrivateMessageKind =
  | 'answer_sources'
  | 'handoff_note'
  | 'draft_note'
  | 'clarify_draft_note'
/** deliveryId + kind ist der Idempotenzschluessel jeder gesendeten Nachricht. */
export type DeliveryMessageKind = PublicMessageKind | PrivateMessageKind

export class ChatwootApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ChatwootApiError'
  }
}

export interface DraftWriteResult {
  written: boolean
  message: string
}

export interface ChatwootPort {
  sendMessage(
    tenant: TenantConfig,
    conversationId: number,
    content: string,
    deliveryId: number,
    kind: PublicMessageKind,
  ): Promise<void>
  /** Interne Notiz — fuer den Kunden nicht sichtbar. */
  sendPrivateNote(
    tenant: TenantConfig,
    conversationId: number,
    content: string,
    deliveryId: number,
    kind: PrivateMessageKind,
  ): Promise<void>
  saveDraft(
    tenant: TenantConfig,
    conversationId: number,
    content: string,
    previousAgentDraft?: string,
  ): Promise<DraftWriteResult>
  setPriority(tenant: TenantConfig, conversationId: number, priority: ConversationPriority): Promise<void>
  /** Ergaenzt Labels, ohne bestehende zu verlieren. */
  addLabels(tenant: TenantConfig, conversationId: number, labels: readonly string[]): Promise<void>
  assign(tenant: TenantConfig, conversationId: number, assigneeId: number): Promise<void>
  handoff(tenant: TenantConfig, conversationId: number): Promise<void>
}

/**
 * Die Sichtbarkeit haengt allein an der Art. Der vollstaendige Record erzwingt
 * die Entscheidung fuer jede neue Art, statt sie am Aufrufer haengen zu lassen.
 */
const PRIVATE_BY_KIND: Record<DeliveryMessageKind, boolean> = {
  answer: false,
  handoff_ack: false,
  answer_sources: true,
  draft_note: true,
  clarify_draft_note: true,
  handoff_note: true,
}

export class ChatwootClient implements ChatwootPort {
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly deliveryStore: ChatwootDeliveryStore,
    private readonly request: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  async sendMessage(
    tenant: TenantConfig,
    conversationId: number,
    content: string,
    deliveryId: number,
    kind: PublicMessageKind,
  ): Promise<void> {
    await this.sendDeliveryMessage(tenant, conversationId, content, deliveryId, kind)
  }

  async sendPrivateNote(
    tenant: TenantConfig,
    conversationId: number,
    content: string,
    deliveryId: number,
    kind: PrivateMessageKind,
  ): Promise<void> {
    await this.sendDeliveryMessage(tenant, conversationId, content, deliveryId, kind)
  }

  async saveDraft(
    tenant: TenantConfig,
    conversationId: number,
    content: string,
    previousAgentDraft?: string,
  ): Promise<DraftWriteResult> {
    const path = `/api/v1/accounts/${tenant.accountId}/conversations/${conversationId}/draft_messages`
    const current = asObject(
      await this.json(
        await this.fetchResponse(tenant, path, { method: 'GET' }),
        'draft',
      ),
    )
    if (
      current?.has_draft === true &&
      typeof current.message === 'string' &&
      current.message &&
      current.message !== previousAgentDraft
    ) {
      return { written: false, message: current.message }
    }
    await this.fetchResponse(tenant, path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft_message: { message: content } }),
    })
    return { written: true, message: content }
  }

  async setPriority(
    tenant: TenantConfig,
    conversationId: number,
    priority: ConversationPriority,
  ): Promise<void> {
    await this.post(tenant, conversationId, 'toggle_priority', { priority })
  }

  async addLabels(
    tenant: TenantConfig,
    conversationId: number,
    labels: readonly string[],
  ): Promise<void> {
    if (labels.length === 0) return
    // Chatwoot ersetzt die Label-Liste komplett; vorhandene Labels muessen
    // deshalb mitgesendet werden, sonst gehen manuelle Labels verloren.
    const existing = await this.currentLabels(tenant, conversationId)
    const missing = [...new Set(labels)].filter((label) => !existing.includes(label))
    if (missing.length === 0) return
    await this.post(tenant, conversationId, 'labels', { labels: [...existing, ...missing] })
  }

  async assign(
    tenant: TenantConfig,
    conversationId: number,
    assigneeId: number,
  ): Promise<void> {
    const response = await this.post(tenant, conversationId, 'assignments', {
      assignee_id: assigneeId,
    })
    // Chatwoot antwortet auch mit 200, wenn niemand zugewiesen wurde.
    const assignee = asObject(await this.json(response, 'assignment'))
    if (assignee?.id !== assigneeId) {
      throw new ChatwootApiError('Chatwoot did not assign the requested user', response.status)
    }
  }

  async handoff(
    tenant: TenantConfig,
    conversationId: number,
  ): Promise<void> {
    await this.post(tenant, conversationId, 'toggle_status', { status: 'open' })
  }

  private async sendDeliveryMessage(
    tenant: TenantConfig,
    conversationId: number,
    content: string,
    deliveryId: number,
    kind: DeliveryMessageKind,
  ): Promise<void> {
    if (
      await this.deliveryStore.exists({
        accountId: tenant.accountId,
        conversationDisplayId: conversationId,
        deliveryId,
        kind,
      })
    ) {
      return
    }
    await this.post(tenant, conversationId, 'messages', {
      content,
      message_type: 'outgoing',
      ...(PRIVATE_BY_KIND[kind] ? { private: true } : {}),
      content_attributes: {
        myinvest_agent_delivery_id: String(deliveryId),
        myinvest_agent_message_kind: kind,
      },
    })
  }

  private async currentLabels(
    tenant: TenantConfig,
    conversationId: number,
  ): Promise<string[]> {
    const path = `/api/v1/accounts/${tenant.accountId}/conversations/${conversationId}/labels`
    const response = await this.fetchResponse(tenant, path, { method: 'GET' })
    const payload = await this.payload(response, 'labels')
    return payload.filter((entry): entry is string => typeof entry === 'string')
  }

  private async post(
    tenant: TenantConfig,
    conversationId: number,
    action: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const path = `/api/v1/accounts/${tenant.accountId}/conversations/${conversationId}/${action}`
    return this.fetchResponse(tenant, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  private async payload(response: Response, context: string): Promise<unknown[]> {
    const entries = asObject(await this.json(response, context))?.payload
    if (!Array.isArray(entries)) {
      throw new ChatwootApiError(`Chatwoot ${context} response has no payload`, response.status)
    }
    return entries
  }

  private async json(response: Response, context: string): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      throw new ChatwootApiError(`Chatwoot ${context} response is not JSON`, response.status)
    }
  }

  private async fetchResponse(
    tenant: TenantConfig,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    let response: Response
    try {
      response = await this.request(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          api_access_token: tenant.agentBotToken,
          'x-forwarded-proto': 'https',
        },
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new ChatwootApiError(`Chatwoot request ${path} failed`, 0)
    }
    if (!response.ok) {
      throw new ChatwootApiError(`Chatwoot request ${path} returned ${response.status}`, response.status)
    }
    return response
  }
}

/**
 * Engt einen JSON-Wert auf ein Objekt ein. Die Assertion ist rein strukturell:
 * jeder Feldzugriff bleibt danach `unknown` und wird einzeln geprueft.
 */
function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as Record<string, unknown>
}
