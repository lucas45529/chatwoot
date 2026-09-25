import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createConnection } from 'node:net'
import type { Request, Response } from 'express'

export const MAX_SCAN_BYTES = 5 * 1024 * 1024
const SIGNING_CONTEXT = 'myinvest-support-attachment-scan/v1\0'
const RESPONSE_CONTEXT = 'myinvest-support-attachment-scan-response/v1\0'

export function scanRequestSignature(secret: string, timestamp: string, requestId: string, digest: string) {
  return createHmac('sha256', secret)
    .update(`${SIGNING_CONTEXT}${timestamp}.${requestId}.${digest}`)
    .digest('hex')
}

export function scanResponseSignature(secret: string, requestId: string, digest: string, verdict: string) {
  return createHmac('sha256', secret)
    .update(`${RESPONSE_CONTEXT}${requestId}.${digest}.${verdict}`)
    .digest('hex')
}

function equalsHex(expected: string, supplied: string) {
  return /^[0-9a-f]{64}$/i.test(supplied) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))
}

export async function scanWithClamd(bytes: Buffer, host: string, port = 3310, timeoutMs = 10_000): Promise<'clean' | 'infected'> {
  if (bytes.length < 1 || bytes.length > MAX_SCAN_BYTES) throw new Error('invalid_scan_size')
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    let settled = false
    let reply = ''
    const fail = () => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error('scanner_unavailable'))
    }
    socket.setTimeout(timeoutMs, fail)
    socket.on('error', fail)
    socket.on('end', () => { if (!settled) fail() })
    socket.on('data', (chunk: Buffer) => {
      reply += chunk.toString('utf8')
      if (reply.length > 1_024) return fail()
      if (!reply.includes('\0') && !reply.includes('\n')) return
      const line = reply.split(/[\0\n]/u)[0] ?? ''
      if (settled) return
      settled = true
      socket.destroy()
      if (line === 'stream: OK') resolve('clean')
      else if (/^stream: .+ FOUND$/u.test(line)) resolve('infected')
      else reject(new Error('scanner_unavailable'))
    })
    socket.on('connect', () => {
      const length = Buffer.alloc(4)
      length.writeUInt32BE(bytes.length)
      socket.write(Buffer.from('zINSTREAM\0'))
      socket.write(length)
      socket.write(bytes)
      socket.write(Buffer.alloc(4))
    })
  })
}

export function attachmentScanHandler(input: {
  secret: string
  claim: (key: string, ttlSeconds: number) => Promise<boolean>
  scan: (bytes: Buffer) => Promise<'clean' | 'infected'>
  maxConcurrent?: number
}) {
  let active = 0
  const maxConcurrent = input.maxConcurrent ?? 2
  return async (request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store')
    const bytes = request.body
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_SCAN_BYTES) {
      return response.status(413).json({ error: 'invalid_scan_size' })
    }
    const timestamp = request.get('x-support-timestamp') ?? ''
    const requestId = request.get('x-support-request-id') ?? ''
    const digest = request.get('x-support-content-sha256') ?? ''
    const signature = request.get('x-support-signature') ?? ''
    const actualDigest = createHash('sha256').update(bytes).digest('hex')
    if (
      input.secret.length < 32 ||
      !/^\d{10}$/u.test(timestamp) ||
      Math.abs(Math.floor(Date.now() / 1_000) - Number(timestamp)) > 300 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId) ||
      digest !== actualDigest ||
      !equalsHex(scanRequestSignature(input.secret, timestamp, requestId, digest), signature)
    ) return response.status(401).json({ error: 'invalid_signature' })
    try {
      if (!await input.claim(`support-attachment-scan:v1:${requestId.toLowerCase()}`, 601)) {
        return response.status(409).json({ error: 'request_already_used' })
      }
    } catch {
      return response.status(503).json({ error: 'scanner_unavailable' })
    }
    if (active >= maxConcurrent) return response.status(503).json({ error: 'scanner_busy' })
    active += 1
    try {
      const verdict = await input.scan(bytes)
      if (verdict !== 'clean' && verdict !== 'infected') throw new Error('invalid_verdict')
      response.setHeader('x-support-scan-signature', scanResponseSignature(input.secret, requestId, digest, verdict))
      // Infected content stays in this isolated scanner request and is discarded.
      return response.status(verdict === 'clean' ? 200 : 422).json({ verdict, sha256: digest })
    } catch {
      return response.status(503).json({ error: 'scanner_unavailable' })
    } finally {
      active -= 1
    }
  }
}
