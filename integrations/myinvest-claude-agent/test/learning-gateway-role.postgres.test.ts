import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { claimLearningGatewayNonce } from '../src/learning/gateway-nonce.js'

it.skipIf(!process.env.LEARNING_TEST_DATABASE_URL)('proves least privilege and durable replay rejection in an isolated PostgreSQL fixture', async () => {
  const url = new URL(process.env.LEARNING_TEST_DATABASE_URL!)
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/learning_gateway_fixture')
    throw new Error('learning_gateway_fixture_target_required')
  const pool = new Pool({ connectionString: url.toString(), max: 1 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const migration of ['001_knowledge.sql', '002_learning.sql', '003_redaction_refresh.sql', '004_redaction_rereview.sql'])
      await client.query(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'))
    await client.query('CREATE TABLE IF NOT EXISTS agent_delivery_ledger (id bigint); CREATE TABLE customer_mail_credentials (id bigint)')
    await client.query(readFileSync(process.env.LEARNING_GATEWAY_ROLE_SQL ?? new URL('../../../deployment/myinvest/sql/learning-gateway-role.sql', import.meta.url), 'utf8'))
    await client.query('SET LOCAL ROLE mi_support_learning')
    const identity = await client.query(`SELECT current_user AS role, rolsuper, rolcreaterole, rolcreatedb,
      has_table_privilege(current_user, 'agent_knowledge_candidates', 'SELECT') AS can_read,
      has_table_privilege(current_user, 'agent_knowledge_candidates', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'agent_knowledge_candidates', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'agent_knowledge_candidates', 'TRUNCATE') AS can_truncate,
      has_table_privilege(current_user, 'agent_delivery_ledger', 'SELECT') AS can_read_delivery,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create
      FROM pg_roles WHERE rolname=current_user`)
    expect(identity.rows[0]).toEqual({ role: 'mi_support_learning', rolsuper: false, rolcreaterole: false, rolcreatedb: false,
      can_read: true, can_insert: true, can_update: true, can_truncate: false, can_read_delivery: false, can_create: false })
    const database = { query: <Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => client.query<Row>(text, [...values]) }
    const key = `support-learning:v1:${randomUUID()}`
    expect(await claimLearningGatewayNonce(database, key, 601)).toBe(true)
    expect(await claimLearningGatewayNonce(database, key, 601)).toBe(false)
    await client.query('UPDATE agent_learning_request_nonces SET expires_at=clock_timestamp() WHERE request_key=$1', [key])
    expect(await claimLearningGatewayNonce(database, key, 601)).toBe(true)
    for (const forbidden of ['SELECT 1 FROM agent_delivery_ledger LIMIT 0',
      'SELECT 1 FROM customer_mail_credentials LIMIT 0',
      'UPDATE agent_learning_audit_events SET id=id WHERE false']) {
      await client.query('SAVEPOINT negative_permission')
      await expect(client.query(forbidden)).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT negative_permission')
    }
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  }
})
