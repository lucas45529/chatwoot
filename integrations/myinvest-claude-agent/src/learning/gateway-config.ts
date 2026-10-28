import { z } from 'zod'
import { tenantKeySchema, type TenantKey } from '../domain.js'

const identity = z.object({
  key: tenantKeySchema,
  accountId: z.number().int().positive(),
  inboxId: z.number().int().positive(),
  agentBotId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
export interface LearningTenantRegistry {
  readonly all: readonly { key: TenantKey; accountId: number; inboxId: number; agentBotId?: number }[]
}
const identities = z.array(identity).length(3).superRefine((values, context) => {
  for (const field of ['key', 'accountId'] as const) {
    if (new Set(values.map(value => value[field])).size !== values.length)
      context.addIssue({ code: 'custom', message: 'Learning tenant identities must be unique' })
  }
})
const databaseUrl = (role: string) => z.string().refine(value => {
  try {
    const url = new URL(value)
    return ['postgres:', 'postgresql:'].includes(url.protocol) &&
      decodeURIComponent(url.username) === role && !!url.hostname && !!url.pathname.slice(1) && !url.search && !url.hash
  } catch { return false }
}, 'Learning database identity is invalid')
const schema = z.object({
  RUN_MODE: z.literal('web'),
  AUTO_SEND_ENABLED: z.literal('false'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: databaseUrl('mi_support_learning'),
  CHATWOOT_DATABASE_URL: databaseUrl('agent_learning_ro'),
  SUPPORT_CHATWOOT_SSO_SECRET: z.string().min(32),
  LEARNING_TENANTS_JSON: z.string().transform((value, context) => {
    try { return identities.parse(JSON.parse(value)) }
    catch { context.addIssue({ code: 'custom', message: 'Learning tenant metadata is invalid' }); return z.NEVER }
  }),
})

/** This process receives no Chatwoot API, webhook, LLM or messaging credentials. */
export function loadLearningGatewayConfig(env: NodeJS.ProcessEnv = process.env) {
  if (Object.keys(env).some(key => !Object.hasOwn(schema.shape, key) && /(?:TOKEN|SECRET|PASSWORD|KEY|TENANTS_JSON)$/.test(key)))
    throw new Error('learning_gateway_forbidden_credential')
  const parsed = schema.safeParse(Object.fromEntries(Object.keys(schema.shape).map(key => [key, env[key]])))
  if (!parsed.success) throw new Error('learning_gateway_configuration_invalid')
  return { ...parsed.data, tenants: { all: parsed.data.LEARNING_TENANTS_JSON } satisfies LearningTenantRegistry }
}
