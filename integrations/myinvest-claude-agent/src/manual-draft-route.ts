import type { RequestHandler } from 'express'
import { authorizeLearningRequest, LearningRequestError } from './learning/review-auth.js'
import { manualDraftRequestSchema, type ManualDraftInput, type ManualDraftResult, type RegenerateDraftInput, type PreviewDraftInput, type DraftPreviewResult } from './manual-draft.js'

interface ManualDraftHttpDependencies {
  secret: string
  claim(key: string, ttl: number): Promise<boolean>
  previewDraft?(input: PreviewDraftInput, signal: AbortSignal): Promise<DraftPreviewResult>
  applyDraft?(input: RegenerateDraftInput, signal: AbortSignal): Promise<ManualDraftResult>
  createDraft(input: ManualDraftInput, signal: AbortSignal): Promise<ManualDraftResult>
}

export function manualDraftHandler(dependencies: ManualDraftHttpDependencies): RequestHandler {
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (!Buffer.isBuffer(request.body)) {
      response.status(415).json({ error: 'application_json_required' })
      return
    }
    const rawBody = request.body.toString('utf8')
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.once('aborted', abort)
    response.once('close', abort)
    const timeout = setTimeout(abort, 55_000)
    try {
      await authorizeLearningRequest({
        secret: dependencies.secret,
        rawBody,
        timestamp: request.get('x-support-timestamp') ?? '',
        requestId: request.get('x-support-request-id') ?? '',
        signature: request.get('x-support-signature') ?? '',
        claim: dependencies.claim,
      })
      let decoded: unknown
      try { decoded = JSON.parse(rawBody) } catch { throw new LearningRequestError(422, 'invalid_json') }
      const command = manualDraftRequestSchema.safeParse(decoded)
      if (!command.success) throw new LearningRequestError(422, 'invalid_draft_command')
      controller.signal.throwIfAborted()
      let result: DraftPreviewResult
      if (command.data.action === 'draft') result = await dependencies.createDraft(command.data, controller.signal)
      else {
        const { action, ...input } = command.data
        const operation = action === 'draft_preview' ? dependencies.previewDraft : dependencies.applyDraft
        if (!operation) throw new LearningRequestError(503, 'draft_unavailable')
        result = await operation(input, controller.signal)
      }
      controller.signal.throwIfAborted()
      response.json(result)
    } catch (error) {
      const status = error instanceof LearningRequestError ? error.status : 503
      response.status(status).json({ error: error instanceof LearningRequestError ? error.message : 'draft_unavailable' })
    } finally {
      clearTimeout(timeout)
      request.removeListener('aborted', abort)
      response.removeListener('close', abort)
    }
  }
}
