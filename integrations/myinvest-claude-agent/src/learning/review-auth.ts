import { createHmac, timingSafeEqual } from 'node:crypto'

export class LearningRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

export async function authorizeLearningRequest(input: {
  secret: string
  rawBody: string
  timestamp: string
  requestId: string
  signature: string
  nowSeconds?: number
  claim: (key: string, ttlSeconds: number) => Promise<boolean>
}): Promise<void> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000)
  if (
    input.secret.length < 32 ||
    !/^\d{10}$/.test(input.timestamp) ||
    Math.abs(now - Number(input.timestamp)) > 300 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId) ||
    !/^[0-9a-f]{64}$/.test(input.signature)
  ) throw new LearningRequestError(401, 'invalid_signature')

  const expected = createHmac('sha256', input.secret)
    .update(`myinvest-support-learning/v1\0${input.timestamp}.${input.requestId}.${input.rawBody}`)
    .digest()
  if (!timingSafeEqual(expected, Buffer.from(input.signature, 'hex'))) {
    throw new LearningRequestError(401, 'invalid_signature')
  }
  // A timestamp may be 300 seconds ahead. Keep the claim through its entire
  // remaining acceptance window, including that allowed future skew.
  if (!await input.claim(`support-learning:v1:${input.requestId.toLowerCase()}`, 601)) {
    throw new LearningRequestError(409, 'request_already_used')
  }
}
