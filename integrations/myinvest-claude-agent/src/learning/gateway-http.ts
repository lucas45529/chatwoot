import express from 'express'
import { authorizeLearningRequest, LearningRequestError } from './review-auth.js'
import { learningCommandSchema, type LearningCommand } from './review-service.js'

export interface LearningGatewayDependencies {
  secret: string
  claim(key: string, ttlSeconds: number): Promise<boolean>
  execute(command: LearningCommand): Promise<unknown>
  health(): Promise<void>
}

/** Only these two capabilities are exposed; no customer-send or worker routes. */
export function createLearningGateway(dependencies: LearningGatewayDependencies) {
  const app = express()
  app.disable('x-powered-by')
  app.post('/learning', express.raw({ type: 'application/json', limit: '16kb' }), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (!Buffer.isBuffer(request.body)) return response.status(415).json({ error: 'application_json_required' })
    const rawBody = request.body.toString('utf8')
    try {
      await authorizeLearningRequest({ secret: dependencies.secret, rawBody,
        timestamp: request.get('x-support-timestamp') ?? '',
        requestId: request.get('x-support-request-id') ?? '',
        signature: request.get('x-support-signature') ?? '',
        claim: dependencies.claim })
      let decoded: unknown
      try { decoded = JSON.parse(rawBody) } catch { throw new LearningRequestError(422, 'invalid_json') }
      const command = learningCommandSchema.safeParse(decoded)
      if (!command.success) throw new LearningRequestError(422, 'invalid_learning_command')
      return response.json(await dependencies.execute(command.data))
    } catch (error) {
      return response.status(error instanceof LearningRequestError ? error.status : 503).json({
        error: error instanceof LearningRequestError ? error.message : 'learning_unavailable',
      })
    }
  })
  app.get('/health', async (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    try { await dependencies.health(); response.json({ status: 'ok', mode: 'learning-only', customerSendEnabled: false }) }
    catch { response.status(503).json({ status: 'unavailable' }) }
  })
  return app
}
