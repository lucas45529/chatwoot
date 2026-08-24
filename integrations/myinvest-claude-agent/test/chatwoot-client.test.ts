import { describe, expect, it, vi } from 'vitest'
import { ChatwootApiError, ChatwootClient } from '../src/chatwoot-client.js'
import { tenants } from './fixtures.js'

describe('ChatwootClient', () => {
  it('uses only the tenant AgentBot token and opens a handoff', async () => {
    const deliveryStore = { exists: vi.fn().mockResolvedValue(false) }
    const request = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const client = new ChatwootClient('https://chat.example.test', deliveryStore, request)
    await client.handoff(tenants[1]!, 77)
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(
      'https://chat.example.test/api/v1/accounts/202/conversations/77/toggle_status',
      expect.objectContaining({
        body: JSON.stringify({ status: 'open' }),
        headers: expect.objectContaining({
          api_access_token: tenants[1]!.agentBotToken,
          'x-forwarded-proto': 'https',
        }),
      }),
    )
  })

  it('stores an AI proposal as a Chatwoot draft instead of sending it', async () => {
    const deliveryStore = { exists: vi.fn().mockResolvedValue(false) }
    const request = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const client = new ChatwootClient('https://chat.example.test', deliveryStore, request)
    const saveDraft: unknown = Reflect.get(client, 'saveDraft')
    expect(typeof saveDraft).toBe('function')
    if (typeof saveDraft !== 'function') return

    await saveDraft.call(client, tenants[0]!, 77, 'Antwortvorschlag')
    expect(request).toHaveBeenCalledWith(
      'https://chat.example.test/api/v1/accounts/101/conversations/77/draft_messages',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ draft_message: { message: 'Antwortvorschlag' } }),
      }),
    )
  })

  it('never overwrites an existing shared draft on retry', async () => {
    const deliveryStore = { exists: vi.fn().mockResolvedValue(false) }
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ has_draft: true, message: 'Menschlich bearbeitet' }), {
        status: 200,
      }),
    )
    const client = new ChatwootClient('https://chat.example.test', deliveryStore, request)
    await client.saveDraft(tenants[0]!, 77, 'Neuer KI-Text')
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]![1]).toEqual(expect.objectContaining({ method: 'GET' }))
  })

  it('does not leak an upstream response or token in errors', async () => {
    const deliveryStore = { exists: vi.fn().mockResolvedValue(false) }
    const request = vi.fn().mockResolvedValue(new Response('secret upstream response', { status: 500 }))
    const client = new ChatwootClient('https://chat.example.test', deliveryStore, request)
    const call = client.sendMessage(tenants[0]!, 77, 'Antwort', 55, 'answer')
    await expect(call).rejects.toEqual(
      expect.objectContaining<Partial<ChatwootApiError>>({ status: 500 }),
    )
    await expect(call).rejects.not.toThrow(/secret upstream|saas-agent-bot-token/)
  })

  it('sends a private note, a priority, a validated assignment and merged labels', async () => {
    const assigneeId = tenants[0]!.handoffAssigneeId
    const deliveryStore = { exists: vi.fn().mockResolvedValue(false) }
    const request = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url.endsWith('/labels') && init.method === 'GET') {
        return Promise.resolve(new Response('{"payload":["support"]}', { status: 200 }))
      }
      if (url.endsWith('/assignments')) {
        return Promise.resolve(new Response(JSON.stringify({ id: assigneeId }), { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    const client = new ChatwootClient('https://chat.example.test', deliveryStore, request)

    await client.sendPrivateNote(tenants[0]!, 77, 'Interner Hinweis', 55, 'handoff_note')
    expect(request).toHaveBeenLastCalledWith(
      'https://chat.example.test/api/v1/accounts/101/conversations/77/messages',
      expect.objectContaining({
        body: JSON.stringify({
          content: 'Interner Hinweis',
          message_type: 'outgoing',
          private: true,
          content_attributes: {
            myinvest_agent_delivery_id: '55',
            myinvest_agent_message_kind: 'handoff_note',
          },
        }),
      }),
    )

    await client.setPriority(tenants[0]!, 77, 'urgent')
    expect(request).toHaveBeenLastCalledWith(
      'https://chat.example.test/api/v1/accounts/101/conversations/77/toggle_priority',
      expect.objectContaining({ body: JSON.stringify({ priority: 'urgent' }) }),
    )

    await client.assign(tenants[0]!, 77, assigneeId)
    expect(request).toHaveBeenLastCalledWith(
      'https://chat.example.test/api/v1/accounts/101/conversations/77/assignments',
      expect.objectContaining({ body: JSON.stringify({ assignee_id: assigneeId }) }),
    )

    await client.addLabels(tenants[0]!, 77, ['ki-uebergabe', 'zugang'])
    expect(request).toHaveBeenLastCalledWith(
      'https://chat.example.test/api/v1/accounts/101/conversations/77/labels',
      expect.objectContaining({
        body: JSON.stringify({ labels: ['support', 'ki-uebergabe', 'zugang'] }),
      }),
    )
  })

  it('does not resend a delivery message already accepted before a timeout', async () => {
    const deliveryStore = { exists: vi.fn().mockResolvedValue(true) }
    const request = vi.fn()
    const client = new ChatwootClient('https://chat.example.test', deliveryStore, request)
    await client.sendMessage(tenants[0]!, 77, 'Antwort', 55, 'answer')
    expect(deliveryStore.exists).toHaveBeenCalledWith({
      accountId: 101,
      conversationDisplayId: 77,
      deliveryId: 55,
      kind: 'answer',
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects a successful assignment response that assigned nobody', async () => {
    const deliveryStore = { exists: vi.fn().mockResolvedValue(false) }
    const request = vi.fn().mockResolvedValue(new Response('null', { status: 200 }))
    const client = new ChatwootClient('https://chat.example.test', deliveryStore, request)
    await expect(client.assign(tenants[0]!, 77, tenants[0]!.handoffAssigneeId)).rejects.toThrow(
      /did not assign/,
    )
  })

  it('skips the label write when nothing would change', async () => {
    const deliveryStore = { exists: vi.fn().mockResolvedValue(false) }
    const request = vi.fn().mockResolvedValue(
      new Response('{"payload":["ki-uebergabe"]}', { status: 200 }),
    )
    const client = new ChatwootClient('https://chat.example.test', deliveryStore, request)
    await client.addLabels(tenants[0]!, 77, ['ki-uebergabe'])
    expect(request).toHaveBeenCalledOnce()
    await client.addLabels(tenants[0]!, 77, [])
    expect(request).toHaveBeenCalledOnce()
  })
})
