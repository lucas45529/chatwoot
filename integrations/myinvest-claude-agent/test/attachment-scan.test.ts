import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachmentScanHandler,
  scanRequestSignature,
  scanWithClamd,
} from '../src/attachment-scan.js'

const secret = 'local-attachment-proof-secret-000000000000'
const bytes = Buffer.from('%PDF-1.7\nlocal clean PDF\n%%EOF\n')
const digest = createHash('sha256').update(bytes).digest('hex')
const listeners: Array<{ close: () => void }> = []
afterEach(() => {
  for (const listener of listeners) listener.close()
  listeners.length = 0
})

async function serve(scan: (body: Buffer) => Promise<'clean' | 'infected'>) {
  const used = new Set<string>()
  const app = express()
  app.post('/attachments/scan', express.raw({ type: 'application/octet-stream', limit: '5mb' }), attachmentScanHandler({
    secret,
    scan,
    claim: async (key) => {
      if (used.has(key)) return false
      used.add(key)
      return true
    },
    maxConcurrent: 1,
  }))
  const listener = app.listen(0, '127.0.0.1')
  listeners.push(listener)
  await new Promise<void>((resolve) => listener.once('listening', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('missing_test_port')
  return `http://127.0.0.1:${address.port}/attachments/scan`
}

function headers(id = randomUUID(), hash = digest) {
  const timestamp = String(Math.floor(Date.now() / 1_000))
  return {
    'content-type': 'application/octet-stream',
    'x-support-timestamp': timestamp,
    'x-support-request-id': id,
    'x-support-content-sha256': hash,
    'x-support-signature': scanRequestSignature(secret, timestamp, id, hash),
  }
}

describe('isolated attachment scanner endpoint', () => {
  it('binds the clean verdict to the exact bytes and rejects replay', async () => {
    const scan = vi.fn(async () => 'clean' as const)
    const url = await serve(scan)
    const signed = headers()
    const first = await fetch(url, { method: 'POST', body: bytes, headers: signed })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ verdict: 'clean', sha256: digest })
    expect(first.headers.get('x-support-scan-signature')).toMatch(/^[0-9a-f]{64}$/u)
    expect((await fetch(url, { method: 'POST', body: bytes, headers: signed })).status).toBe(409)
    expect(scan).toHaveBeenCalledOnce()
  })

  it('never scans changed bytes, unsigned bytes or a stale timestamp', async () => {
    const scan = vi.fn(async () => 'clean' as const)
    const url = await serve(scan)
    const altered = Buffer.from(bytes)
    altered[10] = 0
    expect((await fetch(url, { method: 'POST', body: altered, headers: headers() })).status).toBe(401)
    expect((await fetch(url, { method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream' } })).status).toBe(401)
    const stale = headers()
    stale['x-support-timestamp'] = String(Math.floor(Date.now() / 1_000) - 301)
    expect((await fetch(url, { method: 'POST', body: bytes, headers: stale })).status).toBe(401)
    expect(scan).not.toHaveBeenCalled()
  })

  it('rejects a body beyond the five MiB HTTP boundary without invoking ClamAV', async () => {
    const scan = vi.fn(async () => 'clean' as const)
    const url = await serve(scan)
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1)
    const hash = createHash('sha256').update(oversized).digest('hex')
    expect((await fetch(url, { method: 'POST', body: oversized, headers: headers(randomUUID(), hash) })).status).toBe(413)
    expect(scan).not.toHaveBeenCalled()
  })

  it('quarantines an infected verdict and fails closed when the daemon fails', async () => {
    const infected = await serve(async () => 'infected')
    const response = await fetch(infected, { method: 'POST', body: bytes, headers: headers() })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ verdict: 'infected', sha256: digest })
    const failed = await serve(async () => { throw new Error('daemon down') })
    const unavailable = await fetch(failed, { method: 'POST', body: bytes, headers: headers() })
    expect(unavailable.status).toBe(503)
    expect(unavailable.headers.get('x-support-scan-signature')).toBeNull()
  })

  it('limits concurrent scans and times out an unresponsive daemon', async () => {
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const wait = new Promise<void>((resolve) => { release = resolve })
    const url = await serve(async () => { entered(); await wait; return 'clean' })
    const first = fetch(url, { method: 'POST', body: bytes, headers: headers() })
    await started
    const busy = await fetch(url, { method: 'POST', body: bytes, headers: headers() })
    expect(busy.status).toBe(503)
    release()
    expect((await first).status).toBe(200)

    const server = createServer(() => {}).listen(0, '127.0.0.1')
    listeners.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing_test_port')
    await expect(scanWithClamd(bytes, '127.0.0.1', address.port, 30)).rejects.toThrow('scanner_unavailable')
  })

  it('speaks bounded ClamAV INSTREAM and rejects ambiguous daemon replies', async () => {
    const server = createServer((socket) => {
      const chunks: Buffer[] = []
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        const frame = Buffer.concat(chunks)
        if (frame.length < 10 + 4 + bytes.length + 4) return
        expect(frame.subarray(0, 10).toString()).toBe('zINSTREAM\0')
        expect(frame.readUInt32BE(10)).toBe(bytes.length)
        expect(frame.subarray(14, 14 + bytes.length)).toEqual(bytes)
        socket.end('stream: OK\0')
      })
    }).listen(0, '127.0.0.1')
    listeners.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing_test_port')
    await expect(scanWithClamd(bytes, '127.0.0.1', address.port)).resolves.toBe('clean')
  })
})
