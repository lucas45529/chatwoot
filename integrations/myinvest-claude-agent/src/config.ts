import { z } from 'zod'
import { tenantKeySchema, type TenantKey } from './domain.js'

const tenantSchema = z.object({
  key: tenantKeySchema,
  accountId: z.number().int().positive(),
  webhookSecret: z.string().min(24),
  agentBotToken: z.string().min(24),
  // Chatwoot-User dieses Accounts, der uebergebene Gespraeche bekommt.
  // Pflicht pro Mandant: User-IDs sind nicht account-uebergreifend gueltig.
  handoffAssigneeId: z.number().int().positive(),
})

export type TenantConfig = z.infer<typeof tenantSchema>

export interface TenantRegistry {
  readonly all: readonly TenantConfig[]
  requireByAccountId(accountId: number): TenantConfig
  requireByKey(key: TenantKey): TenantConfig
}

export function buildTenantRegistry(values: readonly TenantConfig[]): TenantRegistry {
  const tenants = values.map((value) => tenantSchema.parse(value))
  if (tenants.length !== 3 || new Set(tenants.map(({ key }) => key)).size !== 3) {
    throw new Error('Exactly one configuration for each of the three tenants is required')
  }
  const accountIds = tenants.map(({ accountId }) => accountId)
  if (new Set(accountIds).size !== accountIds.length) {
    throw new Error('Each tenant must use a unique Chatwoot account ID')
  }
  const credentials = tenants.flatMap(({ webhookSecret, agentBotToken }) => [
    webhookSecret,
    agentBotToken,
  ])
  if (new Set(credentials).size !== credentials.length) {
    throw new Error('Tenant credentials must never be shared')
  }

  const byAccountId = new Map(tenants.map((tenant) => [tenant.accountId, tenant]))
  const byKey = new Map(tenants.map((tenant) => [tenant.key, tenant]))
  return {
    all: tenants,
    requireByAccountId(accountId) {
      const tenant = byAccountId.get(accountId)
      if (!tenant) throw new Error(`Unknown Chatwoot account ID: ${accountId}`)
      return tenant
    },
    requireByKey(key) {
      const tenant = byKey.get(key)
      if (!tenant) throw new Error(`Unknown tenant key: ${key}`)
      return tenant
    },
  }
}

export function parseTenantConfig(value: string): TenantConfig[] {
  let input: unknown
  try {
    input = JSON.parse(value)
  } catch {
    throw new Error('TENANTS_JSON must be valid JSON')
  }
  return [...buildTenantRegistry(z.array(tenantSchema).parse(input)).all]
}

const envSchema = z.object({
  LOCAL_SMOKE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  /** Nur fuer den lokalen E2E-Lauf: feste Gehirn-Antwort statt echter API. */
  LOCAL_FAKE_BRAIN_ANSWER: z.string().max(4_000).optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  RUN_MODE: z.enum(['all', 'web', 'worker']).default('all'),
  DATABASE_URL: z.string().min(1),
  CHATWOOT_DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  CHATWOOT_BASE_URL: z.string().url(),
  TENANTS_JSON: z.string().min(1),
  WEBHOOK_REPLAY_WINDOW_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  DELIVERY_RETENTION_SECONDS: z.coerce.number().int().min(3600).default(86400),
  MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(1048576).default(262144),
  /** Herkunft der Antworten: die Gehirn-API der Website. */
  SUPPORT_ANSWER_URL: z.string().url().max(2_048),
  SUPPORT_ANSWER_SECRET: z.string().min(32).max(512),
  /** Unabhaengiger HMAC-Schluessel fuer irreversible Laufzeit-Pseudonyme. */
  PSEUDONYMIZATION_KEY: z.string().min(32).max(512),
  SUPPORT_CHATWOOT_SSO_SECRET: z.string().min(32).max(512),
  INTERN_SSO_AUDIENCE: z
    .string()
    .min(1)
    .max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i),
  INTERN_SSO_EMAIL: z.string().email().max(320),
  INTERN_SSO_PASSWORD: z.string().min(12).max(1_024),
  INTERN_SSO_RETURN_PATH: z
    .string()
    .regex(/^\/app\/accounts\/[1-9][0-9]*\/inbox\/[1-9][0-9]*$/),
  SUPPORT_ANSWER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(65_000),
  // Scharfschalten ist eine bewusste Entscheidung, kein Nebeneffekt eines
  // Deployments: ohne dieses Flag entsteht weiterhin nur ein Entwurf.
  AUTO_SEND_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  AUTO_SEND_MAX_PER_CONVERSATION: z.coerce.number().int().min(0).max(50).default(3),
  AUTO_SEND_MAX_PER_CONTACT_PER_HOUR: z.coerce.number().int().min(0).max(200).default(10),
  AUTO_SEND_FEEDBACK_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
  /** Chatwoot-Inbox-IDs, die als WhatsApp gelten (z. B. "6"). */
  WHATSAPP_INBOX_IDS: z.string().max(255).default(''),
})

export interface AppConfig extends z.infer<typeof envSchema> {
  whatsappInboxIds: ReadonlySet<number>
  tenants: TenantRegistry
}

/**
 * Die Gehirn-API ist ein Ziel fuer signierte Anfragen mit Kundentext. Sie muss
 * deshalb ein sauberer Origin sein: HTTPS ausserhalb des lokalen Smoke-Laufs,
 * kein Pfad, keine Zugangsdaten, kein Query.
 */
export function validateSupportAnswerUrl(value: string, allowInsecure: boolean): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new Error('SUPPORT_ANSWER_URL must use HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('SUPPORT_ANSWER_URL must not contain credentials, query, or fragment')
  }
  if (url.pathname.replace(/\/+$/, '') !== '') {
    throw new Error('SUPPORT_ANSWER_URL must be an origin without a path')
  }
  return `${url.protocol}//${url.host}`
}

export function parseWhatsappInboxIds(value: string): Set<number> {
  const ids = new Set<number>()
  for (const entry of value.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const id = Number(trimmed)
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error('WHATSAPP_INBOX_IDS must contain positive Chatwoot inbox IDs')
    }
    ids.add(id)
  }
  return ids
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = envSchema.parse(environment)
  if (env.LOCAL_FAKE_BRAIN_ANSWER && !env.LOCAL_SMOKE) {
    throw new Error('LOCAL_FAKE_BRAIN_ANSWER is restricted to LOCAL_SMOKE=true')
  }
  const tenants = buildTenantRegistry(parseTenantConfig(env.TENANTS_JSON))
  const unrelatedSecrets = [
    env.SUPPORT_ANSWER_SECRET,
    env.SUPPORT_CHATWOOT_SSO_SECRET,
    ...tenants.all.flatMap(({ webhookSecret, agentBotToken }) => [
      webhookSecret,
      agentBotToken,
    ]),
  ]
  if (unrelatedSecrets.includes(env.PSEUDONYMIZATION_KEY)) {
    throw new Error('PSEUDONYMIZATION_KEY must be independent from all other credentials')
  }
  if (env.SUPPORT_CHATWOOT_SSO_SECRET === env.SUPPORT_ANSWER_SECRET) {
    throw new Error('SUPPORT_CHATWOOT_SSO_SECRET must be independent')
  }
  if (
    tenants.all.some(({ webhookSecret, agentBotToken }) =>
      [webhookSecret, agentBotToken].includes(env.SUPPORT_CHATWOOT_SSO_SECRET),
    )
  ) {
    throw new Error('SUPPORT_CHATWOOT_SSO_SECRET must be independent')
  }
  return {
    ...env,
    SUPPORT_ANSWER_URL: validateSupportAnswerUrl(env.SUPPORT_ANSWER_URL, env.LOCAL_SMOKE),
    whatsappInboxIds: parseWhatsappInboxIds(env.WHATSAPP_INBOX_IDS),
    tenants,
  }
}
