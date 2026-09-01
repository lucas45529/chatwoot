import { describe, expect, it, vi } from 'vitest'
import { buildTenantRegistry } from '../src/config.js'
import { DeliveryQueue, jobIdForDelivery } from '../src/queue.js'
import { QueueUnavailableError, WebhookController } from '../src/webhook/controller.js'
import { incomingPayload, signedHeaders, tenants } from './fixtures.js'

function draftPayload(
  overrides: Parameters<typeof incomingPayload>[0] = {},
) {
  return {
    ...incomingPayload(overrides),
    content_attributes: { myinvest_agent_action: 'draft' },
  }
}

describe('WebhookController', () => {
  const nowMs = 1_800_000_000_000
  it('queues only signed incoming message_created events', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined)
    const controller = new WebhookController({ tenants: buildTenantRegistry(tenants), queue: { enqueue }, replayWindowSeconds: 300, now: () => nowMs })
    const payload = draftPayload()
    const raw = JSON.stringify(payload)
    expect(await controller.handle(raw, signedHeaders(raw, tenants[0]!.webhookSecret, nowMs))).toEqual({ status: 202, body: { accepted: true } })
    expect(enqueue).toHaveBeenCalledWith(
      tenants[0],
      `message:${payload.id}`,
      expect.objectContaining({ id: payload.id, agentAction: 'draft' }),
    )
    for (const ignored of [draftPayload({ event: 'message_updated' }), draftPayload({ message_type: 'outgoing' }), draftPayload({ private: true })]) {
      const ignoredRaw = JSON.stringify(ignored)
      expect((await controller.handle(ignoredRaw, signedHeaders(ignoredRaw, tenants[0]!.webhookSecret, nowMs))).status).toBe(200)
    }
    const preprocessed = {
      ...incomingPayload(),
      content_attributes: { myinvest_agent_action: 'preprocessed' },
    }
    const preprocessedRaw = JSON.stringify(preprocessed)
    expect(
      (
        await controller.handle(
          preprocessedRaw,
          signedHeaders(
            preprocessedRaw,
            tenants[0]!.webhookSecret,
            nowMs,
          ),
        )
      ).status,
    ).toBe(200)
    expect(enqueue).toHaveBeenCalledTimes(1)
    const unmarked = incomingPayload()
    const unmarkedRaw = JSON.stringify(unmarked)
    expect(
      (
        await controller.handle(
          unmarkedRaw,
          signedHeaders(unmarkedRaw, tenants[0]!.webhookSecret, nowMs),
        )
      ).status,
    ).toBe(200)
    expect(enqueue).toHaveBeenCalledTimes(1)
    const { created_at: _missingCreatedAt, ...missingGeneration } = draftPayload()
    const missingGenerationRaw = JSON.stringify(missingGeneration)
    await expect(
      controller.handle(
        missingGenerationRaw,
        signedHeaders(missingGenerationRaw, tenants[0]!.webhookSecret, nowMs),
      ),
    ).rejects.toThrow()
  })

  it('deduplicates a replay independently of the unsigned delivery header', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined)
    const controller = new WebhookController({
      tenants: buildTenantRegistry(tenants),
      queue: { enqueue },
      replayWindowSeconds: 300,
      now: () => nowMs,
    })
    const payload = draftPayload()
    const raw = JSON.stringify(payload)
    const firstHeaders = signedHeaders(raw, tenants[0]!.webhookSecret, nowMs)
    const replayHeaders = { ...firstHeaders, 'x-chatwoot-delivery': 'attacker-replay-id' }

    await controller.handle(raw, firstHeaders)
    await controller.handle(raw, replayHeaders)

    expect(enqueue.mock.calls.map((call) => call[1])).toEqual([
      `message:${payload.id}`,
      `message:${payload.id}`,
    ])
  })

  it('normalisiert Chatwoot-Anhaenge mit content null statt den Webhook abzulehnen', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined)
    const controller = new WebhookController({
      tenants: buildTenantRegistry(tenants),
      queue: { enqueue },
      replayWindowSeconds: 300,
      now: () => nowMs,
    })
    const rawPayload = { ...draftPayload(), content: null }
    const raw = JSON.stringify(rawPayload)

    await expect(
      controller.handle(
        raw,
        signedHeaders(raw, tenants[0]!.webhookSecret, nowMs),
      ),
    ).resolves.toEqual({ status: 202, body: { accepted: true } })
    expect(enqueue.mock.calls[0]![2]).toEqual(
      expect.objectContaining({ content: '' }),
    )
  })

  it('never queues raw contact PII and forwards only the declared projection', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined)
    const controller = new WebhookController({
      tenants: buildTenantRegistry(tenants),
      queue: { enqueue },
      replayWindowSeconds: 300,
      now: () => nowMs,
    })
    const rawPayload = {
      ...draftPayload(),
      sender: {
        email: 'private@example.invalid',
        phone_number: '+49 170 1234567',
        identifier: null,
        name: 'Private Name',
      },
    }
    const raw = JSON.stringify(rawPayload)
    await controller.handle(raw, signedHeaders(raw, tenants[0]!.webhookSecret, nowMs))
    const queued = enqueue.mock.calls[0]![2]
    // Die Projektion ist die Datenschutzgrenze: was hier nicht steht, sieht
    // weder Redis noch die Gehirn-API. Der Absender wird komplett verworfen.
    expect(Object.keys(queued).sort()).toEqual([
      'account',
      'agentAction',
      'content',
      'conversation',
      'created_at',
      'event',
      'id',
      'inboxId',
      'message_type',
      'private',
    ])
    expect(JSON.stringify(queued)).not.toContain('private@example.invalid')
    expect(JSON.stringify(queued)).not.toContain('1234567')
    expect(JSON.stringify(queued)).not.toContain('Private Name')
  })

  it('turns queue failures into a retryable infrastructure error', async () => {
    const controller = new WebhookController({
      tenants: buildTenantRegistry(tenants),
      queue: { enqueue: vi.fn().mockRejectedValue(new Error('redis down')) },
      replayWindowSeconds: 300,
      now: () => nowMs,
    })
    const raw = JSON.stringify(draftPayload())
    await expect(
      controller.handle(raw, signedHeaders(raw, tenants[0]!.webhookSecret, nowMs)),
    ).rejects.toBeInstanceOf(QueueUnavailableError)
  })
})

describe('DeliveryQueue', () => {
  it('deduplicates by stable tenant-scoped delivery ID', async () => {
    const add = vi.fn().mockResolvedValue({ id: 'job' })
    const queue = new DeliveryQueue({ add }, { retentionSeconds: 86_400 })
    await queue.enqueue(tenants[0]!, 'same-delivery', incomingPayload())
    expect(add.mock.calls[0]![2].jobId).toBe(jobIdForDelivery('saas', 'same-delivery'))
    expect(jobIdForDelivery('saas', 'same-delivery')).not.toBe(jobIdForDelivery('new_academy', 'same-delivery'))
  })
})
