import { z } from 'zod'

export const tenantKeySchema = z.enum(['saas', 'new_academy', 'legacy_academy'])
export type TenantKey = z.infer<typeof tenantKeySchema>

export const chatwootWebhookAccountSchema = z.object({
  account: z.object({ id: z.number().int().positive() }),
})

const rawChatwootWebhookSchema = z.object({
  event: z.string(),
  id: z.number().int().positive(),
  created_at: z.string().datetime(),
  content: z.string().default(''),
  message_type: z.string(),
  private: z.boolean().optional().default(false),
  account: chatwootWebhookAccountSchema.shape.account,
  conversation: z.object({ id: z.number().int().positive() }),
  // Chatwoot liefert nur id und name; die id entscheidet ueber den Kanal.
  inbox: z.object({ id: z.number().int().positive() }).optional(),
})

/**
 * Die Projektion ist die Datenschutzgrenze: alles, was Redis, die Queue oder
 * die Gehirn-API zu sehen bekaeme, steht hier. Kontaktangaben (Name, E-Mail,
 * Telefonnummer) werden vollstaendig verworfen, statt sie mitzuschleppen.
 */
export const chatwootWebhookSchema = rawChatwootWebhookSchema.transform((raw) => ({
  event: raw.event,
  id: raw.id,
  created_at: raw.created_at,
  content: raw.content,
  message_type: raw.message_type,
  private: raw.private,
  account: raw.account,
  conversation: { id: raw.conversation.id },
  inboxId: raw.inbox?.id,
}))

export type ChatwootWebhookPayload = z.infer<typeof chatwootWebhookSchema>

export type ConversationTurnRole = 'customer' | 'human' | 'assistant'

export interface ConversationTurn {
  role: ConversationTurnRole
  text: string
}

export interface ConversationContext {
  turns: ConversationTurn[]
  labels: string[]
  humanRepliedAfterBot: boolean
  /** Historischer Menschenkontakt ausserhalb des kurzen Verlaufsfensters. */
  humanEverReplied: boolean
  /** Pseudonym des Kontakts fuer Ratengrenzen; nie eine Kontaktangabe. */
  contactHash?: string
  /** Nur im signierten Gehirn-Body; nie in Logs oder Verlauf. */
  contactEmail?: string
}

export interface KnowledgeHit {
  sourceId: string
  title: string
  content: string
  metadata: Record<string, unknown>
  score: number
}
