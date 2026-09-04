import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildTenantRegistry,
  loadConfig,
  parseTenantConfig,
  validateSupportAnswerUrl,
} from '../src/config.js'
import { verifyChatwootSignature } from '../src/webhook/signature.js'
import { PSEUDONYMIZATION_KEY, tenants } from './fixtures.js'

/** Pflichtfelder, ohne die der Agent nicht startet. */
const baseEnvironment = {
  DATABASE_URL: 'postgresql://example.invalid/agent',
  CHATWOOT_DATABASE_URL: 'postgresql://example.invalid/chatwoot',
  REDIS_URL: 'redis://example.invalid/1',
  CHATWOOT_BASE_URL: 'https://support.example.invalid',
  TENANTS_JSON: JSON.stringify(tenants),
  SUPPORT_ANSWER_URL: 'https://www.myinvest.example',
  SUPPORT_ANSWER_SECRET: 'a-brain-signing-secret-with-32-chars',
  PSEUDONYMIZATION_KEY,
  SUPPORT_CHATWOOT_SSO_SECRET: 'an-independent-sso-secret-with-32-chars',
  INTERN_SSO_AUDIENCE: 'support.example.invalid',
  INTERN_SSO_EMAIL: 'support@example.invalid',
  INTERN_SSO_PASSWORD: 'a-strong-support-password',
  INTERN_SSO_RETURN_PATH: '/app/accounts/101/inbox/17',
}

describe('tenant configuration', () => {
  it('requires three independent tenants, accounts, and credentials', () => {
    const registry = buildTenantRegistry(tenants)
    expect(registry.requireByAccountId(202).key).toBe('new_academy')
    expect(() => registry.requireByAccountId(999)).toThrow(/unknown chatwoot account/i)
    expect(() => parseTenantConfig(JSON.stringify(tenants.slice(0, 2)))).toThrow(/exactly/i)
    expect(() => buildTenantRegistry([tenants[0]!, { ...tenants[1]!, accountId: 101 }, tenants[2]!])).toThrow(/account/i)
    expect(() => buildTenantRegistry([tenants[0]!, { ...tenants[1]!, agentBotToken: tenants[0]!.agentBotToken }, tenants[2]!])).toThrow(/credential/i)
    const withoutAssignee = tenants.map(({ handoffAssigneeId: _assignee, ...tenant }) => tenant)
    expect(() => parseTenantConfig(JSON.stringify(withoutAssignee))).toThrow(/handoffAssigneeId/)
  })

  it('allows a deterministic brain answer only in explicit local smoke mode', () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, LOCAL_FAKE_BRAIN_ANSWER: 'local only' }),
    ).toThrow(/LOCAL_SMOKE/)
    expect(
      loadConfig({
        ...baseEnvironment,
        LOCAL_SMOKE: 'true',
        LOCAL_FAKE_BRAIN_ANSWER: 'local only',
      }).LOCAL_FAKE_BRAIN_ANSWER,
    ).toBe('local only')
  })

  it('pins the brain API to a clean origin and normalizes the compose value', () => {
    expect(
      loadConfig({ ...baseEnvironment, SUPPORT_ANSWER_URL: 'https://www.myinvest.example/' })
        .SUPPORT_ANSWER_URL,
    ).toBe('https://www.myinvest.example')
    // Kundentext verlaesst den Agenten nur ueber HTTPS; HTTP bleibt dem
    // ausdruecklichen lokalen Smoke-Lauf vorbehalten.
    expect(() =>
      loadConfig({ ...baseEnvironment, SUPPORT_ANSWER_URL: 'http://agent-web:3000' }),
    ).toThrow(/HTTPS/)
    expect(
      loadConfig({
        ...baseEnvironment,
        LOCAL_SMOKE: 'true',
        SUPPORT_ANSWER_URL: 'http://agent-web:3000',
      }).SUPPORT_ANSWER_URL,
    ).toBe('http://agent-web:3000')
  })

  it('requires a signing secret for the brain API and keeps auto-send off by default', () => {
    const config = loadConfig(baseEnvironment)
    // Scharfschalten ist eine bewusste Entscheidung: ohne Env bleibt es Entwurf.
    expect(config.AUTO_SEND_ENABLED).toBe(false)
    expect(config.AUTO_SEND_MAX_PER_CONVERSATION).toBe(3)
    expect(config.AUTO_SEND_MAX_PER_CONTACT_PER_HOUR).toBe(10)
    expect(config.SUPPORT_ANSWER_TIMEOUT_MS).toBe(65_000)

    expect(() => loadConfig({ ...baseEnvironment, SUPPORT_ANSWER_URL: undefined })).toThrow(
      /SUPPORT_ANSWER_URL/,
    )
    expect(() => loadConfig({ ...baseEnvironment, SUPPORT_ANSWER_SECRET: undefined })).toThrow(
      /SUPPORT_ANSWER_SECRET/,
    )
    expect(() =>
      loadConfig({ ...baseEnvironment, SUPPORT_ANSWER_SECRET: 'too-short-secret' }),
    ).toThrow(/SUPPORT_ANSWER_SECRET/)
  })

  it('requires an independent production-length pseudonymization key', () => {
    expect(loadConfig(baseEnvironment).PSEUDONYMIZATION_KEY).toBe(PSEUDONYMIZATION_KEY)
    expect(() =>
      loadConfig({ ...baseEnvironment, PSEUDONYMIZATION_KEY: undefined }),
    ).toThrow(/PSEUDONYMIZATION_KEY/)
    expect(() =>
      loadConfig({ ...baseEnvironment, PSEUDONYMIZATION_KEY: 'too-short' }),
    ).toThrow(/PSEUDONYMIZATION_KEY/)
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        PSEUDONYMIZATION_KEY: baseEnvironment.SUPPORT_ANSWER_SECRET,
      }),
    ).toThrow(/independent/)
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        PSEUDONYMIZATION_KEY: tenants[0]!.agentBotToken,
      }),
    ).toThrow(/independent/)
  })

  it('pins single-account SSO to one audience and one inbox', () => {
    expect(loadConfig(baseEnvironment).INTERN_SSO_RETURN_PATH).toBe(
      '/app/accounts/101/inbox/17',
    )
    expect(() =>
      loadConfig({ ...baseEnvironment, INTERN_SSO_RETURN_PATH: '/app/accounts/2' }),
    ).toThrow(/INTERN_SSO_RETURN_PATH/)
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        INTERN_SSO_RETURN_PATH: '/app/accounts/202/inbox/17',
      }),
    ).toThrow(/saas account/)
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        INTERN_SSO_RETURN_PATH: '/app/accounts/101/inbox/18',
      }),
    ).toThrow(/saas account inbox/)
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        SUPPORT_CHATWOOT_SSO_SECRET: baseEnvironment.SUPPORT_ANSWER_SECRET,
      }),
    ).toThrow(/independent/)
  })

  it('accepts only a credential-free HTTPS origin as the brain endpoint', () => {
    expect(validateSupportAnswerUrl('https://www.myinvest.example/', false)).toBe(
      'https://www.myinvest.example',
    )

    for (const url of [
      'http://www.myinvest.example',
      'https://user:password@www.myinvest.example',
      'https://www.myinvest.example/api/support/answer',
      'https://www.myinvest.example?tenant=saas',
      'https://www.myinvest.example#fragment',
    ]) {
      expect(() => validateSupportAnswerUrl(url, false)).toThrow()
    }

    // Der lokale Smoke-Lauf lockert genau HTTP — und sonst nichts.
    expect(validateSupportAnswerUrl('http://agent-web:3000', true)).toBe('http://agent-web:3000')
    expect(() => validateSupportAnswerUrl('http://agent-web:3000/api', true)).toThrow()
    expect(() => validateSupportAnswerUrl('http://user:pass@agent-web:3000', true)).toThrow()
  })

  it('reads WhatsApp inbox IDs and rejects anything that is not a positive ID', () => {
    expect([...loadConfig(baseEnvironment).whatsappInboxIds]).toEqual([])
    expect([
      ...loadConfig({ ...baseEnvironment, WHATSAPP_INBOX_IDS: ' 6, 7 ,6' }).whatsappInboxIds,
    ]).toEqual([6, 7])
    for (const value of ['0', '-6', 'six', '6.5']) {
      expect(() => loadConfig({ ...baseEnvironment, WHATSAPP_INBOX_IDS: value })).toThrow(
        /WHATSAPP_INBOX_IDS/,
      )
    }
  })
})

describe('Chatwoot signature verification', () => {
  const body = '{"event":"message_created","content":"ä"}'
  const secret = 'a-production-length-webhook-secret'
  const nowMs = 1_800_000_000_000
  const timestamp = Math.floor(nowMs / 1000).toString()
  const sign = (value: string) => `sha256=${createHmac('sha256', secret).update(value).digest('hex')}`

  it('accepts only timestamp-dot-raw-body HMAC inside the replay window', () => {
    expect(() => verifyChatwootSignature({ rawBody: body, secret, timestamp, signature: sign(`${timestamp}.${body}`), nowMs, replayWindowSeconds: 300 })).not.toThrow()
    expect(() => verifyChatwootSignature({ rawBody: `${body} `, secret, timestamp, signature: sign(`${timestamp}.${body}`), nowMs, replayWindowSeconds: 300 })).toThrow(/signature/i)
    expect(() => verifyChatwootSignature({ rawBody: body, secret, timestamp: String(Number(timestamp) - 301), signature: sign(`${Number(timestamp) - 301}.${body}`), nowMs, replayWindowSeconds: 300 })).toThrow(/replay window/i)
  })
})
