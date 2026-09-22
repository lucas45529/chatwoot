import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const SIGNATURE_DOMAIN = 'myinvest-support-sso/v1'
const MAX_TOKEN_AGE_SECONDS = 60
const NONCE_PATTERN = /^[A-Za-z0-9_-]{20,64}$/
export const BETA_EMBED_ORIGIN = 'https://webseite-software-my-invest-git-3703b0-lucas-projects-ac052665.vercel.app'
const APP_BETA_ORIGINS = [
  'https://app-my-invest-pro-git-main-lucas-projects-ac052665.vercel.app',
  'https://app-my-invest-pro-lucas-projects-ac052665.vercel.app',
]

export function isInternEmbedOrigin(origin: string): boolean {
  return origin === BETA_EMBED_ORIGIN || (origin === origin.trim() && /^https:\/\/webseite-software-my-invest-[a-z0-9]{9}-lucas-projects-ac052665\.vercel\.app$/.test(origin))
}

interface TokenPayload {
  v: 1
  aud: string
  iat: number
  exp: number
  nonce: string
  accountId: number
  inboxId: number
}

export interface InternSsoConfig {
  secret: string
  audience: string
  email: string
  password: string
  accountId: number
  inboxId: number
  returnPath: string
  chatwootBaseUrl: string
  embedOrigin?: string
  betaEmbedOrigin?: string
}

export interface NonceStore {
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
    condition: 'NX',
  ): Promise<'OK' | null>
}

export interface InternSsoSession {
  location: string
  cookie: string
}

export class InternSsoError extends Error {
  constructor(
    public readonly status: 401 | 409 | 502 | 503,
    message: string,
  ) {
    super(message)
  }
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  const decoded = Buffer.from(value, 'base64url')
  return decoded.toString('base64url') === value ? decoded : null
}

export function verifyInternSsoToken(
  token: string,
  secret: string,
  audience: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): TokenPayload {
  if (token.length > 2_048) throw new InternSsoError(401, 'invalid ticket')
  const parts = token.split('.')
  if (parts.length !== 2) throw new InternSsoError(401, 'invalid ticket')
  const [encoded, signaturePart] = parts
  const signature = decodeBase64Url(signaturePart ?? '')
  if (!encoded || !signature || signature.length !== 32) {
    throw new InternSsoError(401, 'invalid ticket')
  }
  const expected = createHmac('sha256', secret)
    .update(`${SIGNATURE_DOMAIN}\0${encoded}`)
    .digest()
  if (!timingSafeEqual(signature, expected)) {
    throw new InternSsoError(401, 'invalid ticket')
  }

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new InternSsoError(401, 'invalid ticket')
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    (payload as Partial<TokenPayload>).v !== 1 ||
    (payload as Partial<TokenPayload>).aud !== audience ||
    !Number.isSafeInteger((payload as Partial<TokenPayload>).iat) ||
    !Number.isSafeInteger((payload as Partial<TokenPayload>).exp) ||
    typeof (payload as Partial<TokenPayload>).nonce !== 'string' ||
    !NONCE_PATTERN.test((payload as Partial<TokenPayload>).nonce ?? '') ||
    !Number.isSafeInteger((payload as Partial<TokenPayload>).accountId) ||
    ((payload as Partial<TokenPayload>).accountId ?? 0) <= 0 ||
    !Number.isSafeInteger((payload as Partial<TokenPayload>).inboxId) ||
    ((payload as Partial<TokenPayload>).inboxId ?? 0) <= 0
  ) {
    throw new InternSsoError(401, 'invalid ticket')
  }
  const typed = payload as TokenPayload
  if (
    typed.iat > nowSeconds + 5 ||
    typed.iat < nowSeconds - MAX_TOKEN_AGE_SECONDS ||
    typed.exp < nowSeconds ||
    typed.exp <= typed.iat ||
    typed.exp - typed.iat > MAX_TOKEN_AGE_SECONDS
  ) {
    throw new InternSsoError(401, 'expired ticket')
  }
  return typed
}

function sessionCookie(
  headers: Record<string, string>,
  expiry: number,
  nowSeconds: number,
  requestOrigin?: string,
  embedOrigin = BETA_EMBED_ORIGIN,
  betaEmbedOrigin?: string,
): string {
  const value = encodeURIComponent(JSON.stringify(headers))
  const maxAge = Math.max(1, expiry - nowSeconds)
  // The dashboard must read these auth headers in its own frame. Keep the
  // cookie host-only and partition the approved cross-site Beta embed; the
  // production same-site session retains its existing cookie policy. Origin
  // selects storage only: ticket verification and nonce claiming happen first.
  const partitioned = typeof requestOrigin === 'string' && [BETA_EMBED_ORIGIN, ...APP_BETA_ORIGINS, embedOrigin, betaEmbedOrigin].includes(requestOrigin)
  const isolation = partitioned ? 'SameSite=None; Partitioned' : 'SameSite=Lax'
  return `cw_d_session_info=${value}; Path=/; Max-Age=${maxAge}; Expires=${new Date(expiry * 1_000).toUTCString()}; Secure; ${isolation}`
}

export class InternSsoService {
  constructor(
    private readonly config: InternSsoConfig,
    private readonly nonces: NonceStore,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async createSession(token: string, requestOrigin?: string): Promise<InternSsoSession> {
    if (!isInternEmbedOrigin(this.config.embedOrigin ?? BETA_EMBED_ORIGIN) ||
        (this.config.betaEmbedOrigin !== undefined && !isInternEmbedOrigin(this.config.betaEmbedOrigin))) {
      throw new InternSsoError(503, 'invalid embed origin')
    }
    const now = this.now()
    const payload = verifyInternSsoToken(
      token,
      this.config.secret,
      this.config.audience,
      now,
    )
    const expectedTarget = `/app/accounts/${this.config.accountId}/dashboard?support_history=1`
    if (this.config.returnPath !== expectedTarget) {
      throw new InternSsoError(503, 'invalid support target')
    }
    if (
      payload.accountId !== this.config.accountId ||
      payload.inboxId !== this.config.inboxId
    ) {
      throw new InternSsoError(401, 'invalid ticket target')
    }
    const nonceKey = createHash('sha256').update(payload.nonce).digest('hex')
    let claimed: 'OK' | null
    try {
      claimed = await this.nonces.set(
        `intern-sso:${nonceKey}`,
        '1',
        'EX',
        MAX_TOKEN_AGE_SECONDS,
        'NX',
      )
    } catch {
      throw new InternSsoError(503, 'ticket store unavailable')
    }
    if (claimed !== 'OK') throw new InternSsoError(409, 'ticket already used')

    let authResponse: Response
    try {
      authResponse = await this.request(
        new URL('/auth/sign_in', this.config.chatwootBaseUrl),
        {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'MyInvest-Intern-SSO/1',
            'x-forwarded-proto': 'https',
          },
          body: JSON.stringify({
            email: this.config.email,
            password: this.config.password,
          }),
        },
      )
    } catch {
      throw new InternSsoError(502, 'Chatwoot authentication unavailable')
    }
    if (authResponse.status !== 200) {
      throw new InternSsoError(502, 'Chatwoot authentication rejected')
    }

    const required = ['access-token', 'client', 'expiry', 'token-type', 'uid'] as const
    const authHeaders: Record<string, string> = {}
    for (const name of required) {
      const value = authResponse.headers.get(name)
      if (!value) throw new InternSsoError(502, 'Chatwoot authentication incomplete')
      authHeaders[name] = value
    }
    const authorization = authResponse.headers.get('authorization')
    if (authorization) authHeaders.authorization = authorization
    const expiry = Number(authHeaders.expiry)
    if (
      !Number.isSafeInteger(expiry) ||
      expiry <= now ||
      expiry > now + 90 * 24 * 60 * 60
    ) {
      throw new InternSsoError(502, 'Chatwoot authentication expiry invalid')
    }

    return {
      location: this.config.returnPath,
      cookie: sessionCookie(authHeaders, expiry, now, requestOrigin, this.config.embedOrigin, this.config.betaEmbedOrigin),
    }
  }
}
