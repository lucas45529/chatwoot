import { Client } from 'pg'
import { expect, it } from 'vitest'
import { myinvestAutomatedOutboundSql } from '../src/message-provenance.js'

it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('requires paired bridge provenance and treats unknown imported authors as human', async () => {
  const client = new Client({ connectionString: process.env.LEARNING_TEST_DATABASE_URL })
  await client.connect()
  try {
    const classify = async (sourceId: string | null, attributes: object) => {
      const result = await client.query<{ automated: boolean }>(
        `SELECT ${myinvestAutomatedOutboundSql('message')} AS automated
           FROM (SELECT $1::text AS source_id, $2::json AS content_attributes) message`,
        [sourceId, JSON.stringify(attributes)],
      )
      return result.rows[0]?.automated
    }
    expect(await classify('mip:wa:saas:sys:55', { myinvest_outbound_id: '55', myinvest_outbound_kind: 'reminder' })).toBe(true)
    expect(await classify('mip:wa:saas:out:termin-antwort:56', { myinvest_outbound_id: '56', myinvest_outbound_kind: 'appointment_review_ack' })).toBe(true)
    expect(await classify('mip:wa:saas:sys:55', {})).toBe(false)
    expect(await classify(null, { myinvest_outbound_id: '55', myinvest_outbound_kind: 'reminder' })).toBe(false)
    expect(await classify('mip:history:saas:57', { myinvest_history_author: 'bot' })).toBe(true)
    expect(await classify('mip:history:saas:57', { myinvest_history_author: 'agent' })).toBe(false)
    expect(await classify('mip:history:saas:57', {})).toBe(false)
    expect(await classify('mip:web:saas:58', { myinvest_history_author: 'bot' })).toBe(true)
    expect(await classify('mip:web:saas:58', {})).toBe(false)
  } finally {
    await client.end()
  }
})
