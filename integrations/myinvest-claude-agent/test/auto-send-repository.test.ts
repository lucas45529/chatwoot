import { describe, expect, it, vi } from 'vitest'
import {
  PostgresAutoSendLog,
  PostgresConversationProcessingLock,
} from '../src/auto-send-repository.js'
import type { AutoSendRecord } from '../src/auto-send.js'

const ENTRY: AutoSendRecord = {
  tenantKey: 'saas',
  conversationId: 77,
  messageId: 55,
  contactHash: 'contact-hash',
  questionHash: 'question-hash',
  confidence: 0.82,
  sourceIds: ['source-1'],
  sentText: 'Antwort',
}
const LIMITS = { maxPerConversation: 1, maxPerContactPerHour: 10 }

interface FakeRow extends Record<string, unknown> {
  blocked: boolean
  conversation_count: number
  contact_count: number
  reservation_message_id: number | null
  reservation_contact_hash: string | null
  reservation_question_hash: string | null
  reservation_confidence: number | null
  reservation_source_ids: string[] | null
  reservation_sent_text: string | null
}

function reservationRow(input: {
  conversationCount: number
  contactCount?: number
  reserved: boolean
}): FakeRow {
  return {
    blocked: false,
    conversation_count: input.conversationCount,
    contact_count: input.contactCount ?? 0,
    reservation_message_id: input.reserved ? ENTRY.messageId : null,
    reservation_contact_hash: input.reserved ? ENTRY.contactHash! : null,
    reservation_question_hash: input.reserved ? ENTRY.questionHash : null,
    reservation_confidence: input.reserved ? ENTRY.confidence : null,
    reservation_source_ids: input.reserved ? [...ENTRY.sourceIds] : null,
    reservation_sent_text: input.reserved ? ENTRY.sentText : null,
  }
}

function databaseForRow(row: FakeRow) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [row] })
    .mockResolvedValueOnce({ rows: [] })
  const release = vi.fn()
  const connect = vi.fn().mockResolvedValue({ query, release })
  return { database: { query: vi.fn(), connect }, query, release }
}

describe('PostgresAutoSendLog reservation', () => {
  it('locks conversation and contact before atomically checking both caps and inserting', async () => {
    const { database, query, release } = databaseForRow(
      reservationRow({ conversationCount: 0, contactCount: 2, reserved: true }),
    )
    const log = new PostgresAutoSendLog(database)

    await expect(log.reserve(ENTRY, LIMITS)).resolves.toEqual({
      reserved: true,
      usage: { blocked: false, conversationCount: 0, contactCountLastHour: 2 },
      entry: ENTRY,
    })

    expect(query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual([
      'BEGIN',
      'SELECT',
      'SELECT',
      'WITH',
      'COMMIT',
    ])
    expect(query.mock.calls[1]![0]).toContain('pg_advisory_xact_lock')
    expect(query.mock.calls[1]![1]).toEqual(['myinvest-agent:auto-send:saas:77'])
    expect(query.mock.calls[2]![1]).toEqual(['myinvest-agent:auto-send-contact:saas:contact-hash'])
    expect(query.mock.calls[3]![0]).toContain('INSERT INTO agent_auto_send_log')
    expect(query.mock.calls[3]![0]).toContain('message_id <> $3')
    expect(query.mock.calls[3]![0]).toContain('conversation_count < $9')
    expect(query.mock.calls[3]![0]).toContain('contact_count < $10')
    expect(query.mock.calls[3]![0]).toContain('ON CONFLICT (tenant_key, message_id) DO NOTHING')
    expect(release).toHaveBeenCalledOnce()
  })

  it('serializes concurrent reservations so the conversation cap has one winner', async () => {
    let held = false
    const waiters: Array<() => void> = []
    let reservations = 0

    const acquire = async () => {
      if (!held) {
        held = true
        return
      }
      await new Promise<void>((resolve) => waiters.push(resolve))
      held = true
    }
    const unlock = () => {
      held = false
      waiters.shift()?.()
    }
    const database = {
      async query<Row extends Record<string, unknown>>() {
        return { rows: [] as Row[] }
      },
      async connect() {
        let ownsConversationLock = false
        return {
          async query<Row extends Record<string, unknown>>(
            sql: string,
            values: readonly unknown[] = [],
          ) {
            if (
              sql.includes('pg_advisory_xact_lock') &&
              !String(values[0] ?? '').includes('auto-send-contact')
            ) {
              await acquire()
              ownsConversationLock = true
              return { rows: [] as Row[] }
            }
            if (sql.trimStart().startsWith('WITH usage')) {
              const conversationCount = reservations
              const reserved = conversationCount < LIMITS.maxPerConversation
              if (reserved) reservations += 1
              return {
                rows: [
                  reservationRow({ conversationCount, reserved }) as unknown as Row,
                ],
              }
            }
            if ((sql === 'COMMIT' || sql === 'ROLLBACK') && ownsConversationLock) {
              ownsConversationLock = false
              unlock()
            }
            return { rows: [] as Row[] }
          },
          release() {},
        }
      },
    }
    const log = new PostgresAutoSendLog(database)

    const results = await Promise.all([
      log.reserve(ENTRY, LIMITS),
      log.reserve({ ...ENTRY, messageId: 56 }, LIMITS),
    ])

    expect(results.filter((result) => result.reserved)).toHaveLength(1)
    expect(results.filter((result) => !result.reserved)).toEqual([
      {
        reserved: false,
        verdict: 'conversation_limit',
        usage: { blocked: false, conversationCount: 1, contactCountLastHour: 0 },
      },
    ])
  })

  it('serializes the same contact across conversations so the hourly cap has one winner', async () => {
    const contactLimits = { maxPerConversation: 10, maxPerContactPerHour: 1 }
    let held = false
    const waiters: Array<() => void> = []
    let reservations = 0
    const database = {
      async query<Row extends Record<string, unknown>>() {
        return { rows: [] as Row[] }
      },
      async connect() {
        let ownsContactLock = false
        return {
          async query<Row extends Record<string, unknown>>(
            sql: string,
            values: readonly unknown[] = [],
          ) {
            const lockKey = String(values[0] ?? '')
            if (
              sql.includes('pg_advisory_xact_lock') &&
              lockKey.includes('auto-send-contact')
            ) {
              if (held) {
                await new Promise<void>((resolve) => waiters.push(resolve))
              }
              held = true
              ownsContactLock = true
              return { rows: [] as Row[] }
            }
            if (sql.trimStart().startsWith('WITH usage')) {
              const contactCount = reservations
              const reserved = contactCount < contactLimits.maxPerContactPerHour
              if (reserved) reservations += 1
              return {
                rows: [
                  reservationRow({
                    conversationCount: 0,
                    contactCount,
                    reserved,
                  }) as unknown as Row,
                ],
              }
            }
            if ((sql === 'COMMIT' || sql === 'ROLLBACK') && ownsContactLock) {
              ownsContactLock = false
              held = false
              waiters.shift()?.()
            }
            return { rows: [] as Row[] }
          },
          release() {},
        }
      },
    }
    const log = new PostgresAutoSendLog(database)

    const results = await Promise.all([
      log.reserve(ENTRY, contactLimits),
      log.reserve(
        { ...ENTRY, conversationId: 78, messageId: 56 },
        contactLimits,
      ),
    ])

    expect(results.filter((result) => result.reserved)).toHaveLength(1)
    expect(results.filter((result) => !result.reserved)).toEqual([
      {
        reserved: false,
        verdict: 'contact_rate_limit',
        usage: { blocked: false, conversationCount: 0, contactCountLastHour: 1 },
      },
    ])
  })
  it('uses the same transaction lock for a human block and a reservation', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const release = vi.fn()
    const log = new PostgresAutoSendLog({
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue({ query, release }),
    })

    await log.blockConversation({ tenantKey: 'saas', conversationId: 77, reason: 'human_reply' })

    expect(query.mock.calls[1]![0]).toContain('pg_advisory_xact_lock')
    expect(query.mock.calls[1]![1]).toEqual(['myinvest-agent:auto-send:saas:77'])
    expect(query.mock.calls[2]![0]).toContain('INSERT INTO agent_auto_send_blocks')
    expect(release).toHaveBeenCalledOnce()
  })
})

describe('PostgresConversationProcessingLock', () => {
  it('holds a per-conversation session lock for the complete processor operation', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const release = vi.fn()
    const lock = new PostgresConversationProcessingLock({
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue({ query, release }),
    })
    const operation = vi.fn().mockResolvedValue('done')

    await expect(lock.runExclusive('saas', 77, operation)).resolves.toBe('done')

    expect(query.mock.calls[0]![0]).toContain('pg_advisory_lock')
    expect(query.mock.calls[0]![1]).toEqual(['myinvest-agent:processing:saas:77'])
    expect(operation).toHaveBeenCalledOnce()
    expect(query.mock.calls[1]![0]).toContain('pg_advisory_unlock')
    expect(release).toHaveBeenCalledOnce()
  })
})
