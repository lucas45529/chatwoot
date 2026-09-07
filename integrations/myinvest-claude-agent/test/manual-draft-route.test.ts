import { createHmac, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { manualDraftHandler } from '../src/manual-draft-route.js'

let server: Server | undefined
afterEach(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()) })

async function endpoint() {
  const createDraft = vi.fn().mockResolvedValue({ status: 'ready' })
  const claim = vi.fn().mockResolvedValue(true)
  const app = express()
  app.post('/draft', express.raw({ type: 'application/json', limit: '2kb' }), manualDraftHandler({ secret: 'test-only-draft-secret-at-least-32-characters', claim, createDraft }))
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server!.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No HTTP port')
  const post = (body: string, signatureValid = true, contentType = 'application/json') => {
    const timestamp = String(Math.floor(Date.now() / 1000)); const requestId = randomUUID()
    const signature = createHmac('sha256', 'test-only-draft-secret-at-least-32-characters').update(`myinvest-support-learning/v1\0${timestamp}.${requestId}.${body}`).digest('hex')
    return fetch(`http://127.0.0.1:${address.port}/draft`, { method: 'POST', headers: { 'content-type': contentType, 'x-support-timestamp': timestamp, 'x-support-request-id': requestId, 'x-support-signature': signatureValid ? signature : '0'.repeat(64) }, body })
  }
  return { createDraft, claim, post }
}

describe('signed draft HTTP boundary', () => {
  it('accepts only the signed strict draft command and returns status without answer content', async () => {
    const api = await endpoint()
    const response = await api.post(JSON.stringify({ action: 'draft', accountId: 101, conversationId: 77 }))
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ status: 'ready' })
    expect(api.createDraft).toHaveBeenCalledWith({ action: 'draft', accountId: 101, conversationId: 77 }, expect.any(AbortSignal))
  })

  it('rejects forged signatures, replays, other signed actions and extra client-supplied text', async () => {
    const api = await endpoint(); const command = { action: 'draft', accountId: 101, conversationId: 77 }
    expect((await api.post(JSON.stringify(command), false)).status).toBe(401)
    expect((await api.post(JSON.stringify({ ...command, action: 'list' }))).status).toBe(422)
    expect((await api.post(JSON.stringify({ ...command, answer: 'Untrusted answer' }))).status).toBe(422)
    api.claim.mockResolvedValue(false)
    expect((await api.post(JSON.stringify(command))).status).toBe(409)
    expect(api.createDraft).not.toHaveBeenCalled()
  })

  it('handles malformed bodies and hides internal service errors', async () => {
    const api = await endpoint()
    expect((await api.post('{}', true, 'text/plain')).status).toBe(415)
    expect((await api.post('{')).status).toBe(422)
    api.createDraft.mockRejectedValue(new Error('database-password-never-expose'))
    const response = await api.post(JSON.stringify({ action: 'draft', accountId: 101, conversationId: 77 }))
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'draft_unavailable' })
  })
})
