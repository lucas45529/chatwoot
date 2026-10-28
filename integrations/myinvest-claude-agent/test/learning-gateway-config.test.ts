import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadLearningGatewayConfig } from '../src/learning/gateway-config.js'

const tenants = ['saas', 'new_academy', 'legacy_academy'].map((key, index) => ({
  key, accountId: index + 1, inboxId: 1, agentBotId: index + 10,
}))
const valid = () => ({ RUN_MODE: 'web', AUTO_SEND_ENABLED: 'false',
  DATABASE_URL: 'postgresql://mi_support_learning:synthetic@postgres/claude_agent',
  CHATWOOT_DATABASE_URL: 'postgresql://agent_learning_ro:synthetic@postgres/chatwoot',
  SUPPORT_CHATWOOT_SSO_SECRET: 'synthetic-learning-signature-secret-000000',
  LEARNING_TENANTS_JSON: JSON.stringify(tenants),
})
describe('learning-only service capability', () => {
  it('loads only identity metadata, never customer-send credentials', () => {
    const config = loadLearningGatewayConfig(valid())
    expect(config.RUN_MODE).toBe('web')
    expect(config.AUTO_SEND_ENABLED).toBe('false')
    expect(config.tenants.all).toEqual(tenants)
    expect(Object.keys(config.tenants.all[0]!)).not.toContain('agentBotToken')
  })
  it.each([{ RUN_MODE: 'all' }, { RUN_MODE: 'worker' }, { AUTO_SEND_ENABLED: 'true' }])('refuses customer processing mode %j', override => {
    expect(() => loadLearningGatewayConfig({ ...valid(), ...override })).toThrow('learning_gateway_configuration_invalid')
  })
  it.each(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'SLACK_BOT_TOKEN', 'CHATWOOT_API_TOKEN', 'TENANTS_JSON', 'SUPPORT_ANSWER_SECRET'])('refuses unnecessary credential %s', key => {
    expect(() => loadLearningGatewayConfig({ ...valid(), [key]: 'synthetic-unused-secret' })).toThrow('learning_gateway_forbidden_credential')
  })
  it.each(['GOOGLE_GENERATIVE_AI_API_KEY', 'RESEND_API_KEY', 'PSEUDONYMIZATION_KEY', 'CHATWOOT_AGENT_BOT_TOKEN'])('refuses every unnecessary provider/messaging credential %s', key => {
    expect(() => loadLearningGatewayConfig({ ...valid(), [key]: 'synthetic-unused-secret' })).toThrow('learning_gateway_forbidden_credential')
  })
  it('refuses connection-string query overrides of the pinned database identity', () => {
    expect(() => loadLearningGatewayConfig({ ...valid(), DATABASE_URL: valid().DATABASE_URL + '?user=postgres' })).toThrow('learning_gateway_configuration_invalid')
  })
  it('refuses full tenant credentials instead of silently retaining them', () => {
    const config = valid()
    config.LEARNING_TENANTS_JSON = JSON.stringify(tenants.map(tenant => ({ ...tenant, agentBotToken: 'synthetic-token' })))
    expect(() => loadLearningGatewayConfig(config)).toThrow('learning_gateway_configuration_invalid')
  })
  it.each(['DATABASE_URL', 'CHATWOOT_DATABASE_URL'])('refuses an owner identity for %s', key => {
    expect(() => loadLearningGatewayConfig({ ...valid(), [key]: 'postgresql://postgres:synthetic@postgres/claude_agent' })).toThrow('learning_gateway_configuration_invalid')
  })
  it('refuses duplicate tenant account identities', () => {
    expect(() => loadLearningGatewayConfig({ ...valid(), LEARNING_TENANTS_JSON: JSON.stringify(tenants.map(tenant => ({ ...tenant, accountId: 1 }))) })).toThrow('learning_gateway_configuration_invalid')
  })
  it('entrypoint has no worker, messaging, Redis-admin or model provider imports', () => {
    const source = readFileSync(new URL('../src/learning-server.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from ['"].*(?:bullmq|ioredis|chatwoot-client|support-brain|processor|queue|webhook\/controller)/)
    expect(source).not.toMatch(/new Worker|new Queue|new ChatwootClient|new MessageProcessor/)
  })
})
