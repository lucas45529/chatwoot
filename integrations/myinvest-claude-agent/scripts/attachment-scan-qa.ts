import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { scanWithClamd } from '../src/attachment-scan.js'

// Run only against the dedicated local container; no customer file or provider is used.
const port = Number(process.env.LOCAL_CLAMD_PORT ?? 33310)
assert(Number.isInteger(port) && port > 0 && port < 65536)
const cleanPdf = await readFile(new URL('../test/fixtures/clean-one-page.pdf', import.meta.url))
const harmlessTestSignature = Buffer.from(
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
)
assert.equal(await scanWithClamd(cleanPdf, '127.0.0.1', port), 'clean')
assert.equal(await scanWithClamd(harmlessTestSignature, '127.0.0.1', port), 'infected')
console.log(JSON.stringify({ cleanPdf: 'clean', harmlessTestSignature: 'infected', localOnly: true }))
