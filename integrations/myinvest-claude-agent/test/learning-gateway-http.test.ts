import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createLearningGateway } from '../src/learning/gateway-http.js'

const secret = 'synthetic-learning-signature-secret-000000'
let server: Server
let origin: string
let claims: Set<string>
const execute = vi.fn()
const health = vi.fn()
const claim = vi.fn()
beforeEach(async () => {
  claims = new Set()
  execute.mockResolvedValue({ enabled: true, counts: { pending: 0, published: 0, rejected: 0 } })
  health.mockResolvedValue(undefined)
  claim.mockImplementation(async (key: string) => { if (claims.has(key)) return false; claims.add(key); return true })
  const app = createLearningGateway({ secret, execute, claim, health })
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test_address_invalid')
  origin = `http://127.0.0.1:${address.port}`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  vi.clearAllMocks()
})
function signed(payload: unknown) {
  const body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000)), requestId = randomUUID()
  const signature = createHmac('sha256', secret).update(`myinvest-support-learning/v1\0${timestamp}.${requestId}.${body}`).digest('hex')
  return { method: 'POST', body, headers: { 'content-type': 'application/json',
    'x-support-timestamp': timestamp, 'x-support-request-id': requestId, 'x-support-signature': signature } }
}
describe('learning-only signed HTTP gateway', () => {
  it.each(['saas', 'new_academy', 'legacy_academy'])('accepts existing automatic status protocol for %s', async tenant => {
    const command = { action: 'automatic', operation: 'status', tenant }
    const response = await fetch(`${origin}/learning`, signed(command))
    expect(response.status).toBe(200)
    expect((await response.json()).enabled).toBe(true)
    expect(execute).toHaveBeenCalledWith(command)
  })
  it('rejects an invalid HMAC before claiming a nonce or touching the store', async () => {
    const input = signed({ action: 'automatic', operation: 'status', tenant: 'saas' })
    input.headers['x-support-signature'] = '0'.repeat(64)
    const response = await fetch(`${origin}/learning`, input)
    expect(response.status).toBe(401)
    expect(claim).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
  it('rejects a replay across handler invocations', async () => {
    const input = signed({ action: 'automatic', operation: 'status', tenant: 'saas' })
    expect((await fetch(`${origin}/learning`, input)).status).toBe(200)
    expect((await fetch(`${origin}/learning`, input)).status).toBe(409)
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it.each([{ action: 'automatic', operation: 'status', tenant: 'other-business' },
    { action: 'send_message', tenant: 'saas', message: 'must never send' }])('rejects unsupported tenant/action %j', async command => {
    expect((await fetch(`${origin}/learning`, signed(command))).status).toBe(422)
    expect(execute).not.toHaveBeenCalled()
  })
  it.each(['/webhooks/chatwoot', '/sso', '/manual-draft', '/autonomy-status'])('exposes no customer capability at %s', async path => {
    expect((await fetch(origin + path, signed({}))).status).toBe(404)
    expect(execute).not.toHaveBeenCalled()
  })
  it('reports actual database unavailability as unhealthy', async () => {
    health.mockRejectedValue(new Error('synthetic_db_failure'))
    expect((await fetch(`${origin}/health`)).status).toBe(503)
  })
})
