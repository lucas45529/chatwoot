import { DelayedError, type Job } from 'bullmq'
import type { TenantConfig } from './config.js'
import { DeliveryOwnedElsewhereError, type MessageProcessor } from './processor.js'
import type { DeliveryJob } from './queue.js'
import type { AgentState } from './state.js'
import type { TenantKey } from './domain.js'

/**
 * The ledger hands a claimed delivery to a new run only after five minutes
 * (state.ts beginDelivery). A retry waits a little longer than that.
 */
export const OWNED_DELIVERY_RETRY_DELAY_MS = 5 * 60_000 + 15_000

type JobLike = Pick<Job<DeliveryJob>, 'id' | 'data' | 'opts' | 'attemptsMade' | 'moveToDelayed'>

export function createDeliveryJobHandler(dependencies: {
  processor: Pick<MessageProcessor, 'process' | 'recordFinalFailure'>
  state: Pick<AgentState, 'failDelivery'>
  requireTenant: (key: TenantKey) => TenantConfig
  now?: () => number
}): (job: JobLike, token?: string) => Promise<void> {
  const now = dependencies.now ?? Date.now
  return async (job, token) => {
    const tenant = dependencies.requireTenant(job.data.tenantKey)
    const maxAttempts = job.opts.attempts ?? 1
    const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts
    try {
      await dependencies.processor.process({
        tenant,
        payload: job.data.payload,
        isFinalAttempt,
      })
    } catch (error) {
      if (error instanceof DeliveryOwnedElsewhereError) {
        // Not a failure of this run: the claim belongs to an earlier (usually
        // crashed) run. Touching the ledger here would break a live owner.
        await job.moveToDelayed(now() + OWNED_DELIVERY_RETRY_DELAY_MS, token)
        console.log(
          JSON.stringify({
            event: 'agent_delivery_retry_after_claim',
            tenant: tenant.key,
            conversationId: job.data.payload.conversation.id,
            messageId: job.data.payload.id,
            status: error.status,
            delayMs: OWNED_DELIVERY_RETRY_DELAY_MS,
          }),
        )
        throw new DelayedError()
      }
      if (isFinalAttempt) {
        await dependencies.processor.recordFinalFailure({ tenant, payload: job.data.payload, error })
      }
      try {
        await dependencies.state.failDelivery(tenant.key, job.data.payload.id)
      } catch (stateError) {
        console.error(
          'Agent delivery failure could not be persisted',
          job.id,
          stateError instanceof Error ? stateError.message : String(stateError),
        )
      }
      throw error
    }
  }
}
