import { createHmac, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import express from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import { autonomyStatusHandler } from '../src/autonomy-status-route.js'

let server: Server | undefined
afterEach(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()) })
const secret = 'test-only-status-secret-at-least-32-characters'
async function endpoint() {
  const claim = vi.fn().mockResolvedValue(true)
  const app = express()
  app.post('/autonomy-status', express.raw({ type: 'application/json', limit: '1kb' }), autonomyStatusHandler({ secret, claim, autoSendEnabled: false, maxPerConversation: 0, maxPerContactPerHour: 10 }))
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port')
  return { claim, post: (body: string, valid = true) => {
    const timestamp = String(Math.floor(Date.now() / 1000)); const requestId = randomUUID()
    const signature = createHmac('sha256', secret).update(`myinvest-support-learning/v1\0${timestamp}.${requestId}.${body}`).digest('hex')
    return fetch(`http://127.0.0.1:${address.port}/autonomy-status`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-support-timestamp': timestamp, 'x-support-request-id': requestId, 'x-support-signature': valid ? signature : '0'.repeat(64) }, body })
  } }
}
it('returns only actual operational settings under signed read-only authorization', async () => {
  const api = await endpoint(); const response = await api.post('{"action":"status"}')
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ autoSendEnabled: false, maxPerConversation: 0, maxPerContactPerHour: 10, protocolVersion: 1 })
})
it('rejects invalid signatures, replay, mutation commands and extra fields', async () => {
  const api = await endpoint()
  expect((await api.post('{"action":"status"}', false)).status).toBe(401)
  for (const body of ['{}', '{', '{"action":"enable"}', '{"action":"status","autoSendEnabled":true}']) expect((await api.post(body)).status).toBe(422)
  api.claim.mockResolvedValue(false)
  expect((await api.post('{"action":"status"}')).status).toBe(409)
  api.claim.mockRejectedValue(new Error('secret backend detail'))
  const failure = await api.post('{"action":"status"}')
  expect(failure.status).toBe(503); expect(await failure.json()).toEqual({ error: 'autonomy_status_unavailable' })
})
