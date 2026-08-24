import { describe, expect, it, vi } from 'vitest'
import { ChatwootApiError, ChatwootClient } from '../src/chatwoot-client.js'
import { tenants } from './fixtures.js'

describe('ChatwootClient', () => {
  it('uses only the tenant AgentBot token and opens a handoff', async () => {
    const request = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response('{"payload":[]}', { status: 200 })),
    )
    const client = new ChatwootClient('https://chat.example.test', request)
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

  it('does not leak an upstream response or token in errors', async () => {
    const client = new ChatwootClient('https://chat.example.test', vi.fn().mockResolvedValue(new Response('secret upstream response', { status: 500 })))
    const call = client.sendMessage(tenants[0]!, 77, 'Antwort', 55)
    await expect(call).rejects.toEqual(expect.objectContaining<Partial<ChatwootApiError>>({ status: 500 }))
    await expect(call).rejects.not.toThrow(/secret upstream|saas-agent-bot-token/)
  })

  it('sends a private note, a priority and merges labels without dropping existing ones', async () => {
    const request = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        new Response(url.endsWith('/labels') ? '{"payload":["support"]}' : '{}', { status: 200 }),
      ),
    )
    const client = new ChatwootClient('https://chat.example.test', request)

    await client.sendPrivateNote(tenants[0]!, 77, 'Interner Hinweis')
    expect(request).toHaveBeenLastCalledWith(
      'https://chat.example.test/api/v1/accounts/101/conversations/77/messages',
      expect.objectContaining({
        body: JSON.stringify({ content: 'Interner Hinweis', message_type: 'outgoing', private: true }),
      }),
    )

    await client.setPriority(tenants[0]!, 77, 'urgent')
    expect(request).toHaveBeenLastCalledWith(
      'https://chat.example.test/api/v1/accounts/101/conversations/77/toggle_priority',
      expect.objectContaining({ body: JSON.stringify({ priority: 'urgent' }) }),
    )

    await client.assign(tenants[0]!, 77, 9)
    expect(request).toHaveBeenLastCalledWith(
      'https://chat.example.test/api/v1/accounts/101/conversations/77/assignments',
      expect.objectContaining({ body: JSON.stringify({ assignee_id: 9 }) }),
    )

    await client.addLabels(tenants[0]!, 77, ['ki-uebergabe', 'zugang'])
    expect(request).toHaveBeenLastCalledWith(
      'https://chat.example.test/api/v1/accounts/101/conversations/77/labels',
      expect.objectContaining({ body: JSON.stringify({ labels: ['support', 'ki-uebergabe', 'zugang'] }) }),
    )
  })

  it('skips the label write when nothing would change', async () => {
    const request = vi.fn().mockResolvedValue(new Response('{"payload":["ki-uebergabe"]}', { status: 200 }))
    const client = new ChatwootClient('https://chat.example.test', request)
    await client.addLabels(tenants[0]!, 77, ['ki-uebergabe'])
    expect(request).toHaveBeenCalledOnce()
    await client.addLabels(tenants[0]!, 77, [])
    expect(request).toHaveBeenCalledOnce()
  })
})
