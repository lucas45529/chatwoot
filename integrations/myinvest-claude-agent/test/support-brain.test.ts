import { createHmac } from 'node:crypto'
import { type Mock, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  MAX_HISTORY_TURNS,
  MAX_HISTORY_TURN_CHARS,
  MAX_QUESTION_CHARS,
  MAX_RESPONSE_CHARS,
  SupportBrainClient,
  SupportBrainError,
  type SupportBrainRequest,
  supportAnswerSignature,
} from '../src/support-brain.js'

// Offensichtlicher Dummy-Schluessel: nur fuer die HMAC-Rechnung im Test.
const TEST_SECRET = 'support-brain-test-secret-not-real'
const FIXED_NOW_MS = 1_771_000_000_123
const FIXED_TIMESTAMP = '1771000000'
const ENDPOINT = 'https://myinvest.example.test/api/support/answer'

/** Genau das Bild des Bodys, das ueber die Leitung geht — ohne `any`. */
const sentBodySchema = z.object({
  question: z.string(),
  history: z.array(z.object({ role: z.enum(['user', 'agent']), text: z.string() })),
  tenant: z.string(),
  channel: z.string(),
  contact: z.object({ email: z.string() }).optional(),
  reviewOnly: z.boolean().optional(),
})

function brainRequest(overrides: Partial<SupportBrainRequest> = {}): SupportBrainRequest {
  return {
    question: 'Wie funktioniert das Onboarding?',
    history: [],
    tenant: 'saas',
    channel: 'web',
    ...overrides,
  }
}

function brainPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'answer',
    text: 'Das Onboarding startet mit der Depoteroeffnung.',
    confidence: 0.82,
    sources: [{ title: 'Onboarding-FAQ', url: 'https://myinvest.example.test/faq/onboarding' }],
    safeToAutoSend: false,
    ...overrides,
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clientWith(
  fetchImplementation: typeof fetch,
  options: { timeoutMs?: number } = {},
): SupportBrainClient {
  return new SupportBrainClient({
    // Der abschliessende Slash muss weggetrimmt werden, sonst doppelter Pfad.
    baseUrl: 'https://myinvest.example.test/',
    secret: TEST_SECRET,
    timeoutMs: options.timeoutMs ?? 1_000,
    fetchImplementation,
    now: () => FIXED_NOW_MS,
  })
}

/** Benannter Vertrag fuer das fetch-Doppel statt ReturnType-Ableitung. */
type FetchMock = Mock<typeof fetch>

/** fetch-Doppel, das jeden Aufruf mit derselben Antwort quittiert. */
function respondingFetch(...responses: readonly Response[]): FetchMock {
  let call = 0
  return vi.fn<typeof fetch>(async () => {
    const response = responses[Math.min(call, responses.length - 1)]
    call += 1
    if (!response) throw new Error('Test-Setup ohne Antwort')
    return response
  })
}

function requestInit(mock: FetchMock, index = 0): RequestInit {
  const init = mock.mock.calls[index]?.[1]
  expect(init).toBeDefined()
  return init ?? {}
}

function sentRawBody(mock: FetchMock, index = 0): string {
  const body = requestInit(mock, index).body
  expect(typeof body).toBe('string')
  return typeof body === 'string' ? body : ''
}

describe('supportAnswerSignature', () => {
  it('signiert den kanonischen String aus Zeitstempel und Body, nicht den nackten Body', () => {
    const rawBody = '{"question":"Hallo"}'
    const signature = supportAnswerSignature({
      rawBody,
      timestamp: FIXED_TIMESTAMP,
      secret: TEST_SECRET,
    })

    expect(signature).toBe(
      createHmac('sha256', TEST_SECRET).update(`${FIXED_TIMESTAMP}.${rawBody}`).digest('hex'),
    )
    // Der nackte Body allein waere ohne Zeitbindung beliebig wiedereinspielbar.
    expect(signature).not.toBe(
      createHmac('sha256', TEST_SECRET).update(rawBody).digest('hex'),
    )
  })

  it('ergibt fuer denselben Body mit anderem Zeitstempel eine andere Signatur', () => {
    const rawBody = '{"question":"Hallo"}'
    const first = supportAnswerSignature({ rawBody, timestamp: '1771000000', secret: TEST_SECRET })
    const second = supportAnswerSignature({ rawBody, timestamp: '1771000001', secret: TEST_SECRET })

    expect(first).not.toBe(second)
  })
})

describe('SupportBrainClient · Signatur auf der Leitung', () => {
  it('sendet exakt den Body, der auch signiert wurde', async () => {
    const fetchImplementation = respondingFetch(jsonResponse(brainPayload()))
    await clientWith(fetchImplementation).answer(brainRequest())

    const rawBody = sentRawBody(fetchImplementation)
    const headers = new Headers(requestInit(fetchImplementation).headers)
    // Gegenrechnung ueber die tatsaechlich gesendeten Bytes: ein zweites
    // JSON.stringify mit anderer Schluesselreihenfolge wuerde hier auffallen.
    expect(headers.get('x-support-signature')).toBe(
      supportAnswerSignature({
        rawBody,
        timestamp: headers.get('x-support-timestamp') ?? '',
        secret: TEST_SECRET,
      }),
    )
  })

  it('setzt Signatur- und Zeitstempel-Header auf dem Antwort-Endpunkt', async () => {
    const fetchImplementation = respondingFetch(jsonResponse(brainPayload()))
    await clientWith(fetchImplementation).answer(brainRequest())

    const headers = new Headers(requestInit(fetchImplementation).headers)
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(ENDPOINT)
    expect(headers.get('x-support-timestamp')).toBe(FIXED_TIMESTAMP)
    expect(headers.get('x-support-signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(headers.get('content-type')).toBe('application/json')
  })
})

describe('SupportBrainClient · Contract-Grenzen der Anfrage', () => {
  it('kappt eine zu lange Frage statt sie abzulehnen', async () => {
    const fetchImplementation = respondingFetch(jsonResponse(brainPayload()))
    const answer = await clientWith(fetchImplementation).answer(
      brainRequest({ question: 'f'.repeat(MAX_QUESTION_CHARS + 500) }),
    )

    const sent = sentBodySchema.parse(JSON.parse(sentRawBody(fetchImplementation)))
    expect(sent.question).toHaveLength(MAX_QUESTION_CHARS)
    expect(answer.action).toBe('answer')
  })

  it('kappt den Verlauf auf die juengsten Eintraege und jeden Eintrag auf seine Zeichengrenze', async () => {
    const history = Array.from({ length: MAX_HISTORY_TURNS + 3 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('agent' as const),
      text: `${index}:${'t'.repeat(MAX_HISTORY_TURN_CHARS + 200)}`,
    }))
    const fetchImplementation = respondingFetch(jsonResponse(brainPayload()))
    await clientWith(fetchImplementation).answer(brainRequest({ history }))

    const sent = sentBodySchema.parse(JSON.parse(sentRawBody(fetchImplementation)))
    expect(sent.history).toHaveLength(MAX_HISTORY_TURNS)
    // Der aelteste mitgesendete Eintrag ist Index 3 — die drei aeltesten fallen weg.
    expect(sent.history[0]?.text.startsWith('3:')).toBe(true)
    expect(sent.history.at(-1)?.text.startsWith(`${MAX_HISTORY_TURNS + 2}:`)).toBe(true)
    for (const turn of sent.history) {
      expect(turn.text).toHaveLength(MAX_HISTORY_TURN_CHARS)
    }
  })

  it('transportiert die Kontakt-E-Mail nur im signierten Body', async () => {
    const fetchImplementation = respondingFetch(jsonResponse(brainPayload()))
    await clientWith(fetchImplementation).answer(
      brainRequest({ contact: { email: 'kunde@example.de' } }),
    )

    const raw = sentRawBody(fetchImplementation)
    const sent = sentBodySchema.parse(JSON.parse(raw))
    expect(sent.contact).toEqual({ email: 'kunde@example.de' })
    const headers = new Headers(requestInit(fetchImplementation).headers)
    expect(headers.get('x-support-signature')).toBe(
      supportAnswerSignature({
        rawBody: raw,
        timestamp: FIXED_TIMESTAMP,
        secret: TEST_SECRET,
      }),
    )
  })

  it('transportiert den internen Review-Modus im signierten Body', async () => {
    const fetchImplementation = respondingFetch(jsonResponse(brainPayload()))
    await clientWith(fetchImplementation).answer(
      brainRequest({ reviewOnly: true }),
    )

    const raw = sentRawBody(fetchImplementation)
    const sent = sentBodySchema.parse(JSON.parse(raw))
    expect(sent.reviewOnly).toBe(true)
    const headers = new Headers(requestInit(fetchImplementation).headers)
    expect(headers.get('x-support-signature')).toBe(
      supportAnswerSignature({
        rawBody: raw,
        timestamp: FIXED_TIMESTAMP,
        secret: TEST_SECRET,
      }),
    )
  })
})

describe('SupportBrainClient · Contract-Grenzen der Antwort', () => {
  it('lehnt eine Antwort mit fehlendem Pflichtfeld ab statt still eine Teilantwort zu liefern', async () => {
    const { confidence: _confidence, ...withoutConfidence } = brainPayload()
    const fetchImplementation = respondingFetch(jsonResponse(withoutConfidence))

    await expect(clientWith(fetchImplementation).answer(brainRequest())).rejects.toThrow(
      SupportBrainError,
    )
    // Ein Contract-Bruch ist kein Netzproblem: kein zweiter Versuch.
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it('lehnt eine Antwort mit falschem Feldtyp ab', async () => {
    const fetchImplementation = respondingFetch(jsonResponse(brainPayload({ confidence: '0.82' })))

    await expect(clientWith(fetchImplementation).answer(brainRequest())).rejects.toThrow(
      SupportBrainError,
    )
  })

  it('lehnt eine action ausserhalb der drei erlaubten Werte ab', async () => {
    const fetchImplementation = respondingFetch(jsonResponse(brainPayload({ action: 'send' })))

    await expect(clientWith(fetchImplementation).answer(brainRequest())).rejects.toThrow(
      SupportBrainError,
    )
  })

  it('lehnt eine Antwort ab, die kein JSON ist', async () => {
    const fetchImplementation = respondingFetch(
      new Response('<html>Wartungsseite</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )

    await expect(clientWith(fetchImplementation).answer(brainRequest())).rejects.toThrow(
      SupportBrainError,
    )
  })

  it('nimmt safeToAutoSend wie geliefert und setzt es nie selbst', async () => {
    const blocked = respondingFetch(
      jsonResponse(brainPayload({ safeToAutoSend: false, confidence: 1 })),
    )
    const allowed = respondingFetch(
      jsonResponse(brainPayload({ safeToAutoSend: true, confidence: 0.1, action: 'clarify' })),
    )

    expect((await clientWith(blocked).answer(brainRequest())).safeToAutoSend).toBe(false)
    expect((await clientWith(allowed).answer(brainRequest())).safeToAutoSend).toBe(true)
  })

  it('weist eine Antwort ueber dem Response-Cap ab, ohne sie vollstaendig einzulesen', async () => {
    const chunkChars = 20_000
    const chunkCount = 30
    const chunk = new TextEncoder().encode('x'.repeat(chunkChars))
    let pulledChunks = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulledChunks >= chunkCount) {
          controller.close()
          return
        }
        pulledChunks += 1
        controller.enqueue(chunk)
      },
    })
    const fetchImplementation = respondingFetch(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    )

    await expect(clientWith(fetchImplementation).answer(brainRequest())).rejects.toThrow(
      SupportBrainError,
    )
    // Abgewiesen heisst: der Lesevorgang endet an der Grenze, nicht am Body-Ende.
    // Ein Chunk Vorlauf ist erlaubt, den puffert der ReadableStream selbst.
    expect(pulledChunks).toBeLessThan(chunkCount)
    expect(pulledChunks * chunkChars).toBeLessThanOrEqual(MAX_RESPONSE_CHARS + 2 * chunkChars)
  })
})

describe('SupportBrainClient · Netzverhalten', () => {
  it('wiederholt einen Netzfehler genau einmal und liefert dann die Antwort', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    fetchImplementation
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse(brainPayload()))

    const answer = await clientWith(fetchImplementation).answer(brainRequest())

    expect(answer.text).toContain('Onboarding')
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('wiederholt einen 5xx genau einmal und sendet dabei denselben Body erneut', async () => {
    const fetchImplementation = respondingFetch(
      new Response('upstream down', { status: 503 }),
      jsonResponse(brainPayload()),
    )

    await clientWith(fetchImplementation).answer(brainRequest())

    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(sentRawBody(fetchImplementation, 1)).toBe(sentRawBody(fetchImplementation, 0))
  })

  it('wiederholt einen 4xx nicht, damit ein Signaturfehler die Route nicht hammert', async () => {
    const fetchImplementation = respondingFetch(new Response('bad signature', { status: 401 }))

    await expect(clientWith(fetchImplementation).answer(brainRequest())).rejects.toMatchObject({
      name: 'SupportBrainError',
      status: 401,
    })
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it('endet nach erfolglosem Wiederholungsversuch mit SupportBrainError statt erfundener Antwort', async () => {
    const fetchImplementation = respondingFetch(new Response('still down', { status: 502 }))

    await expect(clientWith(fetchImplementation).answer(brainRequest())).rejects.toMatchObject({
      name: 'SupportBrainError',
      status: 502,
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('bricht bei ueberschrittenem Zeitlimit mit SupportBrainError ab', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) throw new Error('Test-Setup ohne AbortSignal')
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
          })
        }),
    )

    await expect(
      clientWith(fetchImplementation, { timeoutMs: 5 }).answer(brainRequest()),
    ).rejects.toMatchObject({ name: 'SupportBrainError', status: 0 })
    // Ein Zeitlimit-Abbruch gilt als Netzfehler: genau ein Wiederholungsversuch.
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })
})
