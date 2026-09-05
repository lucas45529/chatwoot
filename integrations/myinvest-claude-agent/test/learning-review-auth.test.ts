import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { authorizeLearningRequest, LearningRequestError } from '../src/learning/review-auth.js'

const secret = 'review-secret-'.repeat(4)
const rawBody = JSON.stringify({ action: 'list', tenant: 'saas' })
const timestamp = '1788600000'
const requestId = '891d111e-7744-4290-9edb-6f7a83a89faa'
function headers(body = rawBody, domain = 'myinvest-support-learning/v1\0') {
  return {
    timestamp,
    requestId,
    signature: createHmac('sha256', secret).update(`${domain}${timestamp}.${requestId}.${body}`).digest('hex'),
  }
}

describe('learning review authentication', () => {
  it('claims a signed request once in an isolated replay namespace', async () => {
    const claim = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const input = { secret, rawBody, ...headers(), nowSeconds: Number(timestamp), claim }
    await expect(authorizeLearningRequest(input)).resolves.toBeUndefined()
    expect(claim).toHaveBeenCalledWith(`support-learning:v1:${requestId}`, 601)
    await expect(authorizeLearningRequest(input)).rejects.toMatchObject({ status: 409 })
  })

  it.each([
    { ...headers(), rawBody: rawBody + ' ' },
    { ...headers(rawBody, ''), rawBody },
    { ...headers(), rawBody, timestamp: String(Number(timestamp) - 301) },
    { ...headers(), rawBody, signature: headers().signature.toUpperCase() },
  ])('rejects tampering, other protocols, expiry and invalid hex before replay storage', async (invalid) => {
    const claim = vi.fn()
    await expect(authorizeLearningRequest({ secret, ...invalid, nowSeconds: Number(timestamp), claim }))
      .rejects.toBeInstanceOf(LearningRequestError)
    expect(claim).not.toHaveBeenCalled()
  })
})
