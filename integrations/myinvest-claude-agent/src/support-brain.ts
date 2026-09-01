// Einziger Antwortweg des Agenten: die Gehirn-API der Website.
//
// Warum kein eigenes Modell mehr: es gab zwei getrennte Support-Gehirne — der
// Website-Chat mit Embeddings und Claude Sonnet, und dieser Agent mit eigenem
// Prompt und schwachem Postgres-FTS. Zwei Gehirne heissen zwei Qualitaeten,
// zwei Sperrlisten und zwei Baustellen. Ab hier entscheidet ausschliesslich die
// Gehirn-API, ob eine Antwort ueberhaupt existiert und ob sie automatisch
// rausgehen darf; dieser Client transportiert nur noch.
import { createHmac } from 'node:crypto'
import { z } from 'zod'
import type { TenantKey } from './domain.js'

export type SupportChannel = 'web' | 'whatsapp'

export interface SupportBrainHistoryTurn {
  role: 'user' | 'agent'
  text: string
}

export interface SupportBrainRequest {
  requestId: string
  question: string
  history: readonly SupportBrainHistoryTurn[]
  tenant: TenantKey
  channel: SupportChannel
  contact?: { email: string }
  /** Erzwingt einen internen Composer-Entwurf; niemals Auto-Send. */
  reviewOnly?: boolean
}

const brainAnswerSchema = z.object({
  action: z.enum(['answer', 'clarify', 'handoff']),
  text: z.string().min(1).max(4_000),
  confidence: z.number().min(0).max(1),
  sources: z
    .array(z.object({ title: z.string().max(300), url: z.string().max(2_048) }))
    .max(10),
  safeToAutoSend: z.boolean(),
  reason: z.string().max(500).optional(),
})

export type SupportBrainAnswer = z.infer<typeof brainAnswerSchema>

export interface SupportBrainPort {
  answer(request: SupportBrainRequest): Promise<SupportBrainAnswer>
}

/** Grenzen des Contracts: mehr nimmt die Gehirn-API nicht an. */
export const MAX_QUESTION_CHARS = 2_000
export const MAX_HISTORY_TURNS = 12
export const MAX_HISTORY_TURN_CHARS = 1_500
export const MAX_RESPONSE_CHARS = 200_000

export class SupportBrainError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'SupportBrainError'
  }
}

/**
 * Zeitstempel und eindeutige Request-ID binden den Body an ein einzelnes,
 * dauerhaft beanspruchbares Ereignis. Der Server verwirft wiederholte IDs.
 */
export function supportAnswerSignature(input: {
  rawBody: string
  timestamp: string
  requestId: string
  secret: string
}): string {
  return createHmac('sha256', input.secret)
    .update(`${input.timestamp}.${input.requestId}.${input.rawBody}`)
    .digest('hex')
}

/**
 * Liest den Body nur bis zur Obergrenze. `response.text()` wuerde erst die
 * komplette Antwort puffern und danach messen — damit haette die Grenze genau
 * den Speicher schon verbraucht, den sie verhindern soll.
 */
async function readCappedText(response: Response, maxChars: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
      if (text.length > maxChars) {
        throw new SupportBrainError('Support brain response exceeds size limit', response.status)
      }
    }
  } finally {
    // Rest der Leitung schliessen, egal ob Grenze, Fehler oder Body-Ende.
    await reader.cancel().catch(() => undefined)
  }
  return text + decoder.decode()
}

export class SupportBrainClient implements SupportBrainPort {
  private readonly endpoint: string

  constructor(
    private readonly options: {
      baseUrl: string
      secret: string
      timeoutMs: number
      fetchImplementation?: typeof fetch
      now?: () => number
    },
  ) {
    this.endpoint = `${options.baseUrl.replace(/\/+$/, '')}/api/support/answer`
  }

  async answer(request: SupportBrainRequest): Promise<SupportBrainAnswer> {
    const requestId = z.string().uuid().safeParse(request.requestId)
    if (!requestId.success) {
      throw new SupportBrainError('Support brain request ID is invalid', 400)
    }
    // Genau ein JSON.stringify: der gesendete Body muss byteidentisch der
    // signierte Body sein.
    const rawBody = JSON.stringify({
      question: request.question.slice(0, MAX_QUESTION_CHARS),
      history: request.history.slice(-MAX_HISTORY_TURNS).map((turn) => ({
        role: turn.role,
        text: turn.text.slice(0, MAX_HISTORY_TURN_CHARS),
      })),
      tenant: request.tenant,
      channel: request.channel,
      ...(request.contact
        ? { contact: { email: request.contact.email.slice(0, 320) } }
        : {}),
      ...(request.reviewOnly ? { reviewOnly: true } : {}),
    })
    try {
      return await this.send(rawBody, requestId.data)
    } catch (error) {
      // Genau ein Wiederholungsversuch, und nur bei Netzfehler (Status 0) oder
      // 5xx: ein abgelehnter oder unverstaendlicher Aufruf wird durch
      // Wiederholen nicht besser, kostet aber die Antwortzeit des Kunden.
      const retryable =
        error instanceof SupportBrainError && (error.status === 0 || error.status >= 500)
      if (!retryable) throw error
      return this.send(rawBody, requestId.data)
    }
  }

  private async send(
    rawBody: string,
    requestId: string,
  ): Promise<SupportBrainAnswer> {
    const fetchImplementation = this.options.fetchImplementation ?? fetch
    const timestamp = Math.floor((this.options.now?.() ?? Date.now()) / 1000).toString()
    let response: Response
    try {
      response = await fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-support-timestamp': timestamp,
          'x-support-request-id': requestId,
          'x-support-signature': supportAnswerSignature({
            rawBody,
            timestamp,
            requestId,
            secret: this.options.secret,
          }),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs),
        body: rawBody,
      })
    } catch (error) {
      throw new SupportBrainError(
        `Support brain request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        0,
      )
    }
    if (!response.ok) {
      throw new SupportBrainError(
        `Support brain responded with status ${response.status}`,
        response.status,
      )
    }
    let responseText: string
    try {
      responseText = await readCappedText(response, MAX_RESPONSE_CHARS)
    } catch (error) {
      if (error instanceof SupportBrainError) throw error
      throw new SupportBrainError(
        `Support brain response stream failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
        0,
      )
    }
    let payload: unknown
    try {
      payload = JSON.parse(responseText)
    } catch {
      throw new SupportBrainError('Support brain response is not JSON', response.status)
    }
    const parsed = brainAnswerSchema.safeParse(payload)
    if (!parsed.success) {
      throw new SupportBrainError(
        `Support brain response does not match the contract: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        response.status,
      )
    }
    return parsed.data
  }
}
