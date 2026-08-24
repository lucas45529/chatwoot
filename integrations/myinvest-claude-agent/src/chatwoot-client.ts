import type { TenantConfig } from './config.js'
import type { ConversationPriority } from './triage.js'

export class ChatwootApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ChatwootApiError'
  }
}

export interface ChatwootPort {
  sendMessage(tenant: TenantConfig, conversationId: number, content: string, deliveryId: number): Promise<void>
  /** Interne Notiz — fuer den Kunden nicht sichtbar. */
  sendPrivateNote(tenant: TenantConfig, conversationId: number, content: string): Promise<void>
  setPriority(tenant: TenantConfig, conversationId: number, priority: ConversationPriority): Promise<void>
  /** Ergaenzt Labels, ohne bestehende zu verlieren. */
  addLabels(tenant: TenantConfig, conversationId: number, labels: readonly string[]): Promise<void>
  assign(tenant: TenantConfig, conversationId: number, assigneeId: number): Promise<void>
  handoff(tenant: TenantConfig, conversationId: number): Promise<void>
}

export class ChatwootClient implements ChatwootPort {
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly request: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  async sendMessage(
    tenant: TenantConfig,
    conversationId: number,
    content: string,
    deliveryId: number,
  ): Promise<void> {
    await this.post(tenant, conversationId, 'messages', {
      content,
      message_type: 'outgoing',
      content_attributes: { myinvest_agent_delivery_id: String(deliveryId) },
    })
  }

  async sendPrivateNote(
    tenant: TenantConfig,
    conversationId: number,
    content: string,
  ): Promise<void> {
    await this.post(tenant, conversationId, 'messages', {
      content,
      message_type: 'outgoing',
      private: true,
    })
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
    const merged = [...existing]
    for (const label of labels) {
      if (!merged.includes(label)) merged.push(label)
    }
    if (merged.length === existing.length) return
    await this.post(tenant, conversationId, 'labels', { labels: merged })
  }

  async assign(
    tenant: TenantConfig,
    conversationId: number,
    assigneeId: number,
  ): Promise<void> {
    await this.post(tenant, conversationId, 'assignments', { assignee_id: assigneeId })
  }

  async handoff(
    tenant: TenantConfig,
    conversationId: number,
  ): Promise<void> {
    await this.post(tenant, conversationId, 'toggle_status', { status: 'open' })
  }

  private async currentLabels(
    tenant: TenantConfig,
    conversationId: number,
  ): Promise<string[]> {
    const path = `/api/v1/accounts/${tenant.accountId}/conversations/${conversationId}/labels`
    const response = await this.fetchResponse(tenant, path, { method: 'GET' })
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object' || !('payload' in body)) return []
    const payload: unknown = body.payload
    if (!Array.isArray(payload)) return []
    return payload.filter((entry): entry is string => typeof entry === 'string')
  }

  private async post(
    tenant: TenantConfig,
    conversationId: number,
    action: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const path = `/api/v1/accounts/${tenant.accountId}/conversations/${conversationId}/${action}`
    await this.fetchResponse(tenant, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
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
