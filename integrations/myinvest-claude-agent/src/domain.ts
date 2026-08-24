import { z } from 'zod'

export const tenantKeySchema = z.enum(['saas', 'new_academy', 'legacy_academy'])
export type TenantKey = z.infer<typeof tenantKeySchema>

export const chatwootWebhookAccountSchema = z.object({
  account: z.object({ id: z.number().int().positive() }),
})

const contactIdentitySchema = z.object({
  email: z.string().nullish(),
  phone_number: z.string().nullish(),
  identifier: z.string().nullish(),
  name: z.string().nullish(),
})

const rawChatwootWebhookSchema = z.object({
  event: z.string(),
  id: z.number().int().positive(),
  created_at: z.string().datetime(),
  content: z.string().default(''),
  message_type: z.string(),
  private: z.boolean().optional().default(false),
  account: chatwootWebhookAccountSchema.shape.account,
  conversation: z.object({
    id: z.number().int().positive(),
    meta: z.object({ sender: contactIdentitySchema.optional() }).optional(),
  }),
  sender: contactIdentitySchema.optional(),
})

/** Raw contact fields are reduced before the payload reaches Redis or a model. */
export const chatwootWebhookSchema = rawChatwootWebhookSchema.transform((raw) => {
  const sender = raw.sender ?? raw.conversation.meta?.sender
  return {
    event: raw.event,
    id: raw.id,
    created_at: raw.created_at,
    content: raw.content,
    message_type: raw.message_type,
    private: raw.private,
    account: raw.account,
    conversation: { id: raw.conversation.id },
    identity: {
      hasEmail: Boolean(sender?.email?.trim()),
      hasPhone: Boolean(sender?.phone_number?.trim()),
      hasIdentifier: Boolean(sender?.identifier?.trim()),
    },
  }
})

export type ChatwootWebhookPayload = z.infer<typeof chatwootWebhookSchema>

export type ConversationTurnRole = 'customer' | 'human' | 'assistant'

export interface ConversationTurn {
  role: ConversationTurnRole
  text: string
}

export interface ConversationContext {
  turns: ConversationTurn[]
  labels: string[]
  needsIdentityClarification: boolean
  hasContactChannel: boolean
  humanRepliedAfterBot: boolean
}

export interface KnowledgeHit {
  sourceId: string
  title: string
  content: string
  metadata: Record<string, unknown>
  score: number
}
