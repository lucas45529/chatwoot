import { describe, expect, it, vi } from 'vitest'
import { PostgresAutoSendLog } from '../src/auto-send-repository.js'

describe('PostgresAutoSendLog usage', () => {
  it('nimmt nur die aktuelle Delivery aus beiden Limits aus', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ blocked: false, conversation_count: '2', contact_count: '4' }],
    })
    const log = new PostgresAutoSendLog({ query })

    await expect(
      log.usage({
        tenantKey: 'saas',
        conversationId: 77,
        messageId: 55,
        contactHash: 'contact-hash',
      }),
    ).resolves.toEqual({
      blocked: false,
      conversationCount: 2,
      contactCountLastHour: 4,
    })

    const [sql, values] = query.mock.calls[0] as [string, readonly unknown[]]
    expect(sql.match(/message_id <> \$4/g)).toHaveLength(2)
    expect(values).toEqual(['saas', 77, 'contact-hash', 55])
  })
})
