import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'
import { z } from 'zod'
import { tenantKeySchema } from '../domain.js'
import { classifyHistoryCandidates } from './classify-history.js'

const databaseUrl = process.env.DATABASE_URL || process.env.CLAUDE_AGENT_DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const configPath = resolve(process.argv[2] ?? 'scripts/history-learning-tenants.json')
const assignments = z
  .record(z.string().min(1), tenantKeySchema)
  .parse(JSON.parse(await readFile(configPath, 'utf8')))
if (Object.keys(assignments).length === 0) throw new Error('History tenant map is empty')

const pool = new pg.Pool({ connectionString: databaseUrl })
try {
  const result = await classifyHistoryCandidates(pool, assignments)
  console.log(JSON.stringify({ event: 'history_candidates_classified', ...result }))
} finally {
  await pool.end()
}
