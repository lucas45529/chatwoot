import pg from 'pg'
import { loadLearningGatewayConfig } from './learning/gateway-config.js'
import { createLearningGateway } from './learning/gateway-http.js'
import { claimLearningGatewayNonce } from './learning/gateway-nonce.js'
import { AutomaticLearningService } from './learning/automatic-service.js'
import { discoverAutomaticLearningSources, resolveAutomaticLearningSource } from './learning/automatic-source.js'
import { LearningReviewService } from './learning/review-service.js'
import { PostgresLearningSourceResolver } from './learning/source.js'

const config = loadLearningGatewayConfig()
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 4, connectionTimeoutMillis: 5_000, statement_timeout: 20_000 })
const chatwoot = new pg.Pool({ connectionString: config.CHATWOOT_DATABASE_URL, max: 2, connectionTimeoutMillis: 5_000, statement_timeout: 20_000 })
async function health() {
  const [identity, readonlyIdentity] = await Promise.all([
    pool.query<{ role: string; session_role: string; unsafe: boolean }>(`SELECT current_user AS role, session_user AS session_role,
      (rolsuper OR rolcreaterole OR rolcreatedb OR
        has_table_privilege(current_user, 'agent_delivery_ledger', 'SELECT') OR
        has_table_privilege(current_user, 'agent_auto_send_log', 'UPDATE')) AS unsafe
      FROM pg_roles WHERE rolname = current_user`),
    chatwoot.query<{ role: string; session_role: string; unsafe: boolean }>(`SELECT current_user AS role, session_user AS session_role,
      (rolsuper OR rolcreaterole OR rolcreatedb OR
        has_table_privilege(current_user, 'users', 'SELECT') OR
        has_table_privilege(current_user, 'messages', 'UPDATE')) AS unsafe
      FROM pg_roles WHERE rolname = current_user`),
    pool.query('SELECT 1 FROM agent_learning_request_nonces LIMIT 0'),
  ])
  if (identity.rows[0]?.role !== 'mi_support_learning' || identity.rows[0].session_role !== 'mi_support_learning' || identity.rows[0].unsafe !== false ||
      readonlyIdentity.rows[0]?.role !== 'agent_learning_ro' || readonlyIdentity.rows[0].session_role !== 'agent_learning_ro' || readonlyIdentity.rows[0].unsafe !== false)
    throw new Error('learning_gateway_database_privilege_invalid')
}
await health()
const automatic = new AutomaticLearningService(pool, {
  discover: (tenant, cursor) => discoverAutomaticLearningSources(chatwoot, config.tenants, { tenant, ...(cursor ? { cursor } : {}) }),
  resolve: input => resolveAutomaticLearningSource(chatwoot, config.tenants, input),
})
const review = new LearningReviewService(pool, new PostgresLearningSourceResolver(chatwoot, config.tenants), automatic)
const app = createLearningGateway({ secret: config.SUPPORT_CHATWOOT_SSO_SECRET,
  claim: (key, ttl) => claimLearningGatewayNonce(pool, key, ttl),
  execute: command => review.execute(command), health })
const server = app.listen(config.PORT, '0.0.0.0', () => console.info('learning_gateway_ready'))
async function shutdown() {
  server.close()
  await Promise.all([pool.end(), chatwoot.end()])
}
process.once('SIGTERM', () => { void shutdown() })
process.once('SIGINT', () => { void shutdown() })
