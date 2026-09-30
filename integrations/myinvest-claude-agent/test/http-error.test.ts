import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { QueueUnavailableError } from '../src/webhook/controller.js'
import { webhookHttpError } from '../src/webhook/http-error.js'
import { SignatureError } from '../src/webhook/signature.js'

describe('webhookHttpError', () => {
  it('uses Chatwoot retryable status 500 for queue failures', () => {
    expect(webhookHttpError(new QueueUnavailableError())).toEqual({
      status: 500,
      body: { error: 'queue unavailable' },
      log: true,
    })
  })

  it('keeps signature failures non-retryable and private', () => {
    expect(webhookHttpError(new SignatureError('secret detail'))).toEqual({
      status: 401,
      body: { error: 'invalid signature' },
      log: false,
    })
  })

  it('logs schema-rejected webhooks with field paths only, never values', () => {
    const parsed = z.object({ created_at: z.string().datetime() }).safeParse({ created_at: '2026-09-30T10:00:00+02:00 Juliane' })
    if (parsed.success) throw new Error('expected a schema error')
    const rejection = webhookHttpError(parsed.error)
    expect(rejection).toMatchObject({ status: 400, body: { error: 'invalid payload' }, log: true })
    expect(rejection.detail).toBe('schema:created_at')
    expect(JSON.stringify(rejection)).not.toContain('Juliane')
    expect(webhookHttpError(new SyntaxError('Unexpected token'))).toMatchObject({ status: 400, log: false })
  })
})
