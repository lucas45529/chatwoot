import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { scanWithClamd } from './attachment-scan.js'
import { inspectVoiceOgg, MAX_VOICE_BYTES } from './audio-media.js'

const SIGNING_CONTEXT = 'myinvest-support-audio-transcription/v1\0'
const responseSchema = z.object({
  transcript: z.string().trim().min(1).max(2_000),
  requiresConfirmation: z.literal(true),
  source: z.object({
    accountId: z.number().int().positive(), inboxId: z.number().int().positive(),
    conversationId: z.number().int().positive(), sourceMessageId: z.number().int().positive(),
    attachmentId: z.number().int().positive(), durationMs: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict(),
})

export interface AudioTranscriptionPort {
  transcribe(input: {
    bytes: Buffer; requestId: string; accountId: number; inboxId: number;
    conversationId: number; sourceMessageId: number; attachmentId: number;
  }): Promise<string | undefined>
}

export class AudioTranscriptionClient implements AudioTranscriptionPort {
  private active = 0
  constructor(private readonly config: {
    answerUrl: string; secret: string; clamavHost: string; enabled: boolean;
    request?: typeof fetch; scan?: typeof scanWithClamd;
  }) {}

  async transcribe(input: Parameters<AudioTranscriptionPort['transcribe']>[0]): Promise<string | undefined> {
    if (!this.config.enabled || this.active >= 2 || input.bytes.length > MAX_VOICE_BYTES) return undefined
    this.active += 1
    try {
      const inspected = inspectVoiceOgg(input.bytes)
      if (!inspected) return undefined
      if (await (this.config.scan ?? scanWithClamd)(input.bytes, this.config.clamavHost) !== 'clean')
        return undefined
      const source = {
        accountId: input.accountId, inboxId: input.inboxId,
        conversationId: input.conversationId, sourceMessageId: input.sourceMessageId,
        attachmentId: input.attachmentId,
        durationMs: Math.ceil(inspected.seconds * 1_000), sha256: inspected.sha256,
      }
      const encoded = Buffer.from(JSON.stringify(source)).toString('base64url')
      const timestamp = String(Math.floor(Date.now() / 1_000))
      const signature = createHmac('sha256', this.config.secret)
        .update(`${SIGNING_CONTEXT}${timestamp}.${input.requestId}.${encoded}.${inspected.sha256}`)
        .digest('hex')
      const endpoint = new URL(this.config.answerUrl)
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) return undefined
      endpoint.pathname = '/api/support/audio/transcribe'
      endpoint.search = ''
      endpoint.hash = ''
      const response = await (this.config.request ?? fetch)(endpoint, {
        method: 'POST', body: Uint8Array.from(input.bytes), redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'content-type': 'audio/ogg', 'x-support-timestamp': timestamp,
          'x-support-request-id': input.requestId,
          'x-support-audio-source': encoded, 'x-support-signature': signature,
        },
      })
      if (!response.ok || !response.body) return undefined
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > 8_192) { await reader.cancel(); return undefined }
          chunks.push(part.value)
        }
      } finally { reader.releaseLock() }
      const parsed = responseSchema.safeParse(JSON.parse(Buffer.concat(chunks.map(Buffer.from)).toString('utf8')))
      return parsed.success && JSON.stringify(parsed.data.source) === JSON.stringify(source)
        ? parsed.data.transcript : undefined
    } catch { return undefined }
    finally { this.active -= 1 }
  }
}
