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
  it.each([0, 2])('retries a still-claimed delivery after the claim expires instead of dropping it (attempt %i)', async attemptsMade => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const f = setup(new DeliveryOwnedElsewhereError('processing'))
    f.job.attemptsMade = attemptsMade
    await expect(f.handle(f.job as never, 'token-1')).rejects.toBeInstanceOf(DelayedError)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"agent_delivery_retry_after_claim"'))
    logSpy.mockRestore()
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
    expect(f.processor.process).toHaveBeenCalledWith(expect.objectContaining({ isFinalAttempt: true }))
    expect(f.job.moveToDelayed).not.toHaveBeenCalled()
  })

  it('leaves the human handoff to the final attempt only', async () => {
    const f = setup(new Error('brain down'))
    await expect(f.handle(f.job as never)).rejects.toThrow('brain down')
    expect(f.processor.recordFinalFailure).not.toHaveBeenCalled()
    expect(f.state.failDelivery).toHaveBeenCalledWith('saas', 55)
  })

  it('keeps the original error when the ledger update fails too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('brain down')
    const f = setup(error)
    f.state.failDelivery.mockRejectedValueOnce(new Error('db down'))
    await expect(f.handle(f.job as never)).rejects.toBe(error)
  })

  it('completes normally when processing succeeds', async () => {
    const f = setup()
    await f.handle(f.job as never)
    expect(f.processor.process).toHaveBeenCalledWith(expect.objectContaining({ isFinalAttempt: false }))
    expect(f.state.failDelivery).not.toHaveBeenCalled()
  })
})
