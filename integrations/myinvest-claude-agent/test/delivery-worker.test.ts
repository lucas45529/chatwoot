import { DelayedError } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'
import { createDeliveryJobHandler, OWNED_DELIVERY_RETRY_DELAY_MS } from '../src/delivery-worker.js'
import { DeliveryOwnedElsewhereError } from '../src/processor.js'
import { incomingPayload, tenants } from './fixtures.js'

function setup(processError?: unknown) {
  const processor = {
    process: vi.fn(async () => { if (processError) throw processError }),
    recordFinalFailure: vi.fn(async () => undefined),
  }
  const state = { failDelivery: vi.fn(async () => undefined) }
  const job = {
    id: 'job-1',
    data: { tenantKey: tenants[0]!.key, payload: incomingPayload() },
    opts: { attempts: 3 },
    attemptsMade: 0,
    moveToDelayed: vi.fn(async () => undefined),
  }
  const handle = createDeliveryJobHandler({ processor, state, requireTenant: () => tenants[0]!, now: () => 1_000 })
  return { processor, state, job, handle }
}

describe('delivery worker', () => {
  it('retries a still-claimed delivery after the claim expires instead of dropping it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const f = setup(new DeliveryOwnedElsewhereError('processing'))
    await expect(f.handle(f.job as never, 'token-1')).rejects.toBeInstanceOf(DelayedError)
    expect(f.job.moveToDelayed).toHaveBeenCalledWith(1_000 + OWNED_DELIVERY_RETRY_DELAY_MS, 'token-1')
    expect(OWNED_DELIVERY_RETRY_DELAY_MS).toBeGreaterThan(5 * 60_000)
    // The claim belongs to another run: this run must not touch the ledger.
    expect(f.state.failDelivery).not.toHaveBeenCalled()
    expect(f.processor.recordFinalFailure).not.toHaveBeenCalled()
  })

  it('still records real failures and rethrows them', async () => {
    const error = new Error('brain down')
    const f = setup(error)
    f.job.attemptsMade = 2
    await expect(f.handle(f.job as never, 'token-1')).rejects.toBe(error)
    expect(f.state.failDelivery).toHaveBeenCalledWith('saas', 55)
    expect(f.processor.recordFinalFailure).toHaveBeenCalledOnce()
    expect(f.job.moveToDelayed).not.toHaveBeenCalled()
  })

  it('completes normally when processing succeeds', async () => {
    const f = setup()
    await f.handle(f.job as never)
    expect(f.processor.process).toHaveBeenCalledWith(expect.objectContaining({ isFinalAttempt: false }))
    expect(f.state.failDelivery).not.toHaveBeenCalled()
  })
})
