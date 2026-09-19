import type { RequestHandler } from 'express'
import { z } from 'zod'
import { authorizeLearningRequest, LearningRequestError } from './learning/review-auth.js'

const commandSchema = z.object({ action: z.literal('status') }).strict()
export function autonomyStatusHandler(dependencies: {
  secret: string
  claim(key: string, ttl: number): Promise<boolean>
  autoSendEnabled: boolean
  maxPerConversation: number
  maxPerContactPerHour: number
}): RequestHandler {
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (!Buffer.isBuffer(request.body)) {
      response.status(415).json({ error: 'application_json_required' })
      return
    }
    const rawBody = request.body.toString('utf8')
    try {
      await authorizeLearningRequest({
        secret: dependencies.secret, rawBody,
        timestamp: request.get('x-support-timestamp') ?? '',
        requestId: request.get('x-support-request-id') ?? '',
        signature: request.get('x-support-signature') ?? '',
        claim: dependencies.claim,
      })
      let decoded: unknown
      try { decoded = JSON.parse(rawBody) } catch { throw new LearningRequestError(422, 'invalid_json') }
      if (!commandSchema.safeParse(decoded).success) throw new LearningRequestError(422, 'invalid_status_command')
      response.json({
        autoSendEnabled: dependencies.autoSendEnabled,
        maxPerConversation: dependencies.maxPerConversation,
        maxPerContactPerHour: dependencies.maxPerContactPerHour,
        protocolVersion: 1,
      })
    } catch (error) {
      response.status(error instanceof LearningRequestError ? error.status : 503).json({ error: error instanceof LearningRequestError ? error.message : 'autonomy_status_unavailable' })
    }
  }
}
