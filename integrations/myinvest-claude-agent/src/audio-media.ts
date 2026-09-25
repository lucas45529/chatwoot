import { createHash } from 'node:crypto'

export const MAX_VOICE_BYTES = 2 * 1024 * 1024
export const MAX_VOICE_SECONDS = 120

/** Accept only a complete, single-stream Ogg/Opus recording with a bounded timeline. */
export function inspectVoiceOgg(bytes: Uint8Array): { seconds: number; sha256: string } | undefined {
  if (bytes.length < 64 || bytes.length > MAX_VOICE_BYTES) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  let pages = 0
  let serial: number | undefined
  let preSkip: number | undefined
  let finalGranule = -1
  let ended = false
  while (offset < bytes.length) {
    if (++pages > 5_000 || offset + 27 > bytes.length ||
      String.fromCharCode(...bytes.subarray(offset, offset + 4)) !== 'OggS' ||
      bytes[offset + 4] !== 0) return undefined
    const flags = bytes[offset + 5]!
    const granule = view.getBigUint64(offset + 6, true)
    const pageSerial = view.getUint32(offset + 14, true)
    const sequence = view.getUint32(offset + 18, true)
    const segmentCount = bytes[offset + 26]!
    if (offset + 27 + segmentCount > bytes.length ||
      (serial !== undefined && pageSerial !== serial) || sequence !== pages - 1 ||
      (pages === 1 && (flags & 0x02) === 0) || ended) return undefined
    serial = pageSerial
    let payloadSize = 0
    for (let index = 0; index < segmentCount; index++) payloadSize += bytes[offset + 27 + index]!
    const payloadOffset = offset + 27 + segmentCount
    const next = payloadOffset + payloadSize
    if (next > bytes.length) return undefined
    let checksum = 0
    for (let index = offset; index < next; index++) {
      checksum ^= (index >= offset + 22 && index < offset + 26 ? 0 : bytes[index]!) << 24
      for (let bit = 0; bit < 8; bit++)
        checksum = (checksum & 0x80000000 ? (checksum << 1) ^ 0x04c11db7 : checksum << 1) >>> 0
    }
    if (view.getUint32(offset + 22, true) !== checksum) return undefined
    if (pages === 1) {
      if (payloadSize < 19 ||
        String.fromCharCode(...bytes.subarray(payloadOffset, payloadOffset + 8)) !== 'OpusHead' ||
        bytes[payloadOffset + 8] !== 1 || bytes[payloadOffset + 9]! < 1 ||
        bytes[payloadOffset + 9]! > 2) return undefined
      preSkip = view.getUint16(payloadOffset + 10, true)
    }
    if (granule !== 0xffffffffffffffffn) {
      if (granule > BigInt(Number.MAX_SAFE_INTEGER) || Number(granule) < finalGranule) return undefined
      finalGranule = Number(granule)
    }
    ended = (flags & 0x04) !== 0
    offset = next
  }
  if (!ended || preSkip === undefined || finalGranule <= preSkip) return undefined
  const seconds = (finalGranule - preSkip) / 48_000
  if (seconds <= 0 || seconds > MAX_VOICE_SECONDS) return undefined
  return { seconds, sha256: createHash('sha256').update(bytes).digest('hex') }
}

export function activeStorageProxyUrl(rawUrl: string, baseUrl: string): string | undefined {
  try {
    const source = new URL(rawUrl)
    const base = new URL(baseUrl)
    const match = /^\/rails\/active_storage\/blobs\/(?:redirect|proxy)\/([^/]+\/[^/]+)$/u.exec(source.pathname)
    const disposition = source.search
      ? source.searchParams.size === 1 && source.searchParams.get('disposition') === 'inline'
      : true
    if (!match || (source.protocol !== 'https:' && source.origin !== base.origin) ||
      !disposition || source.username || source.password || source.hash ||
      /%(?:2f|5c|00)/iu.test(source.pathname)) return undefined
    return `${base.origin}/rails/active_storage/blobs/proxy/${match[1]}${source.search}`
  } catch { return undefined }
}

export async function readBoundedVoice(response: Response, expectedBytes: number): Promise<Buffer | undefined> {
  if (!response.ok || !response.body || response.redirected ||
    !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_VOICE_BYTES) return undefined
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_VOICE_BYTES) return undefined
  const chunks: Buffer[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_VOICE_BYTES || size > expectedBytes) {
        await reader.cancel()
        return undefined
      }
      chunks.push(Buffer.from(part.value))
    }
  } finally { reader.releaseLock() }
  return size === expectedBytes ? Buffer.concat(chunks, size) : undefined
}

export async function readBoundedJson(response: Response, maxBytes = 64 * 1024): Promise<unknown> {
  if (!response.body || response.redirected) throw new Error('audio_source_unavailable')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new Error('audio_source_unavailable') }
      chunks.push(Buffer.from(part.value))
    }
  } finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown
}
