import { loadConfig } from './config.js'
import { SupportBrainClient } from './support-brain.js'

const config = loadConfig()
const client = new SupportBrainClient({
  baseUrl: config.SUPPORT_ANSWER_URL,
  secret: config.SUPPORT_ANSWER_SECRET,
  timeoutMs: config.SUPPORT_ANSWER_TIMEOUT_MS,
})

await client.answer({
  question: 'Ist die Support-Antwort-API erreichbar?',
  history: [],
  tenant: 'saas',
  channel: 'web',
})

process.stdout.write('Support brain provider check passed.\n')
