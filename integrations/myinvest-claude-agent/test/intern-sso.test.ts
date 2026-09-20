import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  InternSsoError,
  InternSsoService,
  verifyInternSsoToken,
  type InternSsoConfig,
  type NonceStore,
} from '../src/intern-sso.js'

const NOW = 1_800_000_000
const SECRET = 'independent-sso-secret-that-is-long-123'
const AUDIENCE = 'support.example.com'

function ticket(overrides: Record<string, unknown> = {}, secret = SECRET): string {
  const encoded = Buffer.from(
    JSON.stringify({
      v: 1,
      aud: AUDIENCE,
      iat: NOW,
      exp: NOW + 45,
      nonce: 'abcdefghijklmnopqrstuvwx',
      accountId: 1,
      inboxId: 1,
      ...overrides,
    }),
    'utf8',
  ).toString('base64url')
  const signature = createHmac('sha256', secret)
    .update(`myinvest-support-sso/v1\0${encoded}`)
    .digest('base64url')
  return `${encoded}.${signature}`
}

const config: InternSsoConfig = {
  secret: SECRET,
  audience: AUDIENCE,
  email: 'support@example.com',
  password: 'a-password-that-is-never-returned',
  accountId: 1,
  inboxId: 1,
  returnPath: '/app/accounts/1/dashboard?support_history=1',
  chatwootBaseUrl: 'http://rails:3000',
}

function authResponse(status = 200): Response {
  return new Response('{}', {
    status,
    headers: {
      'access-token': 'private-access-token',
      client: 'private-client',
      expiry: String(NOW + 14 * 24 * 60 * 60),
      'token-type': 'Bearer',
      uid: 'support@example.com',
      authorization: 'Bearer private-access-token',
    },
  })
}

describe('Intern-SSO', () => {
  it('akzeptiert nur das richtige Audience-, Signatur- und Zeitfenster', () => {
    expect(verifyInternSsoToken(ticket(), SECRET, AUDIENCE, NOW).nonce).toBe(
      'abcdefghijklmnopqrstuvwx',
    )
    expect(() => verifyInternSsoToken(ticket(), 'wrong-secret'.repeat(4), AUDIENCE, NOW)).toThrow(
      InternSsoError,
    )
    expect(() => verifyInternSsoToken(ticket({ aud: 'other.example' }), SECRET, AUDIENCE, NOW)).toThrow(
      InternSsoError,
    )
    expect(() => verifyInternSsoToken(ticket({ iat: NOW - 61, exp: NOW - 1 }), SECRET, AUDIENCE, NOW)).toThrow(
      /expired/,
    )
    expect(() => verifyInternSsoToken(ticket({ exp: NOW + 61 }), SECRET, AUDIENCE, NOW)).toThrow(
      /expired/,
    )
  })

  it('verbraucht die Nonce atomar, meldet Chatwoot serverseitig an und setzt nur das Sitzungscookie', async () => {
    const nonces: NonceStore = { set: vi.fn().mockResolvedValue('OK') }
    const request = vi.fn().mockResolvedValue(authResponse())
    const session = await new InternSsoService(
      config,
      nonces,
      request,
      () => NOW,
    ).createSession(ticket())

    expect(nonces.set).toHaveBeenCalledWith(
      expect.stringMatching(/^intern-sso:[a-f0-9]{64}$/),
      '1',
      'EX',
      60,
      'NX',
    )
    expect(request).toHaveBeenCalledWith(
      new URL('http://rails:3000/auth/sign_in'),
      expect.objectContaining({ method: 'POST', redirect: 'manual' }),
    )
    const requestBody = JSON.parse(request.mock.calls[0]![1].body)
    expect(requestBody).toEqual({
      email: config.email,
      password: config.password,
    })
    expect(session.location).toBe('/app/accounts/1/dashboard?support_history=1')
    expect(session.cookie).toContain('cw_d_session_info=')
    expect(session.cookie).toContain('Secure; SameSite=Lax')
    expect(session.cookie).not.toContain(config.password)
  })

  it('bindet das Ticket an genau den konfigurierten Account und die Inbox', async () => {
    const service = new InternSsoService(
      config,
      { set: vi.fn().mockResolvedValue('OK') },
      vi.fn().mockResolvedValue(authResponse()),
      () => NOW,
    )

    await expect(
      service.createSession(ticket({ accountId: 2 })),
    ).rejects.toMatchObject({ status: 401 })
    await expect(
      service.createSession(ticket({ inboxId: 2 })),
    ).rejects.toMatchObject({ status: 401 })
  })

  it('weist Wiederholung, Redis-Ausfall, MFA und Session-Limit fail-closed ab', async () => {
    const replay = new InternSsoService(
      config,
      { set: vi.fn().mockResolvedValue(null) },
      vi.fn(),
      () => NOW,
    )
    await expect(replay.createSession(ticket())).rejects.toMatchObject({ status: 409 })

    const redisDown = new InternSsoService(
      config,
      { set: vi.fn().mockRejectedValue(new Error('down')) },
      vi.fn(),
      () => NOW,
    )
    await expect(redisDown.createSession(ticket())).rejects.toMatchObject({ status: 503 })

    for (const status of [206, 401, 409, 429]) {
      const service = new InternSsoService(
        config,
        { set: vi.fn().mockResolvedValue('OK') },
        vi.fn().mockResolvedValue(authResponse(status)),
        () => NOW,
      )
      await expect(service.createSession(ticket())).rejects.toMatchObject({ status: 502 })
    }
  })

  it('akzeptiert Chatwoots 60-Tage-Sitzung, aber keine unbeschränkte Laufzeit', async () => {
    const responseWithExpiry = (days: number) => {
      const response = authResponse()
      response.headers.set('expiry', String(NOW + days * 24 * 60 * 60))
      return response
    }
    const service = (days: number) =>
      new InternSsoService(
        config,
        { set: vi.fn().mockResolvedValue('OK') },
        vi.fn().mockResolvedValue(responseWithExpiry(days)),
        () => NOW,
      )

    await expect(service(60).createSession(ticket())).resolves.toMatchObject({
      location: config.returnPath,
    })
    await expect(service(91).createSession(ticket())).rejects.toMatchObject({
      status: 502,
    })
  })
})

const BETA_ORIGIN = 'https://webseite-software-my-invest-git-3703b0-lucas-projects-ac052665.vercel.app'
const PINNED_ORIGIN = 'https://webseite-software-my-invest-59y5oogio-lucas-projects-ac052665.vercel.app'

describe('pinned nested Intern support origins', () => {
  it('preserves valid legacy tickets without Origin while still requiring signature and nonce', async () => {
    const set = vi.fn().mockResolvedValue('OK')
    const request = vi.fn().mockResolvedValue(authResponse())
    const service = new InternSsoService({ ...config, embedOrigin: PINNED_ORIGIN }, { set }, request, () => NOW)
    for (const origin of [undefined, 'null', 'https://evil.example', `${PINNED_ORIGIN}/`]) {
      expect((await service.createSession(ticket(), origin)).cookie).toContain('; Secure; SameSite=Lax')
    }
    expect(set).toHaveBeenCalledTimes(4)
    expect(request).toHaveBeenCalledTimes(4)
    await expect(service.createSession(ticket({}, 'wrong-secret'))).rejects.toMatchObject({ status: 401 })
    set.mockResolvedValue(null)
    await expect(service.createSession(ticket())).rejects.toMatchObject({ status: 409 })
    expect(request).toHaveBeenCalledTimes(4)
  })
  it.each([
    PINNED_ORIGIN,
    'https://app-my-invest-pro-git-main-lucas-projects-ac052665.vercel.app',
    'https://app-my-invest-pro-lucas-projects-ac052665.vercel.app',
  ])('uses partitioned storage for exactly the configured nested parent: %s', async (origin) => {
    const service = new InternSsoService({ ...config, embedOrigin: PINNED_ORIGIN }, { set: vi.fn().mockResolvedValue('OK') }, vi.fn().mockResolvedValue(authResponse()), () => NOW)
    expect((await service.createSession(ticket(), origin)).cookie).toContain('; Secure; SameSite=None; Partitioned')
  })

  it('does not allow a sibling deployment or malformed configured origin', async () => {
    for (const embedOrigin of [`${PINNED_ORIGIN}/`, `${PINNED_ORIGIN} https://evil.example`, 'https://evil.example']) {
      const service = new InternSsoService({ ...config, embedOrigin }, { set: vi.fn().mockResolvedValue('OK') }, vi.fn().mockResolvedValue(authResponse()), () => NOW)
      await expect(service.createSession(ticket(), embedOrigin)).rejects.toMatchObject({ status: 503 })
    }
    const service = new InternSsoService({ ...config, embedOrigin: PINNED_ORIGIN }, { set: vi.fn().mockResolvedValue('OK') }, vi.fn().mockResolvedValue(authResponse()), () => NOW)
    expect((await service.createSession(ticket(), PINNED_ORIGIN.replace('59y5oogio', 'aaaaaaaaa'))).cookie).toContain('SameSite=Lax')
  })
})

describe('Beta embedded SSO cookie isolation', () => {
  it('creates a host-only partitioned secure session only for the exact approved Beta parent', async () => {
    const service = new InternSsoService(config, { set: vi.fn().mockResolvedValue('OK') }, vi.fn().mockResolvedValue(authResponse()), () => NOW)
    const session = await service.createSession(ticket(), BETA_ORIGIN)
    expect(session.cookie).toContain('; Secure; SameSite=None; Partitioned')
    expect(session.cookie).not.toMatch(/;\s*(?:Domain|HttpOnly)(?:=|;|$)/i)
    expect(session.location).toBe(config.returnPath)
    expect(session.cookie).not.toContain(config.password)
  })

  it.each([
    undefined, 'null', 'https://www.myinvest-pro.de', 'https://app.myinvest-pro.de',
    'https://evil.example', 'https://another-preview.vercel.app', `${BETA_ORIGIN}.evil.example`,
    `${BETA_ORIGIN}/`, `${BETA_ORIGIN}:443`, BETA_ORIGIN.replace('https:', 'http:'),
    `${BETA_ORIGIN}\nhttps://evil.example`,
  ])('keeps the original same-site cookie for non-Beta or malformed origins: %s', async (origin) => {
    const service = new InternSsoService(config, { set: vi.fn().mockResolvedValue('OK') }, vi.fn().mockResolvedValue(authResponse()), () => NOW)
    const session = await service.createSession(ticket(), origin)
    expect(session.cookie).toContain('; Secure; SameSite=Lax')
    expect(session.cookie).not.toContain('Partitioned')
    expect(session.cookie).not.toContain('SameSite=None')
  })

  it('never treats the approved Beta origin as authentication or a replay exemption', async () => {
    const request = vi.fn().mockResolvedValue(authResponse())
    const set = vi.fn().mockResolvedValue('OK')
    const service = new InternSsoService(config, { set }, request, () => NOW)
    await expect(service.createSession(ticket({}, 'wrong-secret'), BETA_ORIGIN)).rejects.toMatchObject({ status: 401 })
    await expect(service.createSession(ticket({ accountId: 2 }), BETA_ORIGIN)).rejects.toMatchObject({ status: 401 })
    expect(set).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    set.mockResolvedValue(null)
    await expect(service.createSession(ticket(), BETA_ORIGIN)).rejects.toMatchObject({ status: 409 })
    expect(request).not.toHaveBeenCalled()
  })
})
