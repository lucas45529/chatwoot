#!/usr/bin/env node
// Retrieval-Eval: typische Kundenfragen muessen Wissen ueber KNOWLEDGE_MIN_SCORE
// finden — sonst landen sie live im retrieval_miss-Handoff. Laeuft gegen die
// echte Agent-Datenbank, z.B. im Container:
//   docker exec myinvest-chatwoot-claude-agent-1 node scripts/eval-retrieval.mjs
// Lokal: DATABASE_URL=... pnpm eval:retrieval
import pg from 'pg'
import { PostgresKnowledgeRepository } from '../dist/knowledge/repository.js'

const databaseUrl = process.env.CLAUDE_AGENT_DATABASE_URL || process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL (oder CLAUDE_AGENT_DATABASE_URL) fehlt')
  process.exit(2)
}

const MIN_SCORE = Number(process.env.KNOWLEDGE_MIN_SCORE ?? 0.05)

// Jede Frage: minScore fuer den Top-Treffer, optional erwartetes Wort im Titel.
const CASES = [
  { tenant: 'saas', q: 'Was kostet MyInvest Pro?', title: 'Was-kostet-MyInvest-Pro' },
  { tenant: 'saas', q: 'Wie viel kostet die Software im Monat?' },
  { tenant: 'saas', q: 'Wie funktioniert die AfA bei Denkmalimmobilien?', title: 'AfA' },
  { tenant: 'saas', q: 'Was ist die Sonder-AfA nach §7b EStG?', title: 'AfA' },
  { tenant: 'saas', q: 'Welche KfW-Förderung gibt es?', title: 'KfW-Foerderung' },
  { tenant: 'saas', q: 'Welche KfW-Foerderung gibt es?', title: 'KfW-Foerderung' },
  { tenant: 'saas', q: 'Wie berechne ich die Rendite einer Immobilie?', title: 'Rendite' },
  { tenant: 'saas', q: 'Was ist der Unterschied zwischen MyInvest 24 und MyInvest Pro?' },
  { tenant: 'saas', q: 'Gibt es eine kostenlose Testphase?' },
  { tenant: 'saas', q: 'Kann ich meine Daten exportieren?' },
  {
    tenant: 'saas',
    q: 'Hallo, ich bekomme keinen Zugriff auf meine MyInvest App. Könnt ihr mir einen Link zum Anmelden schicken?',
    title: 'Zugang',
  },
  { tenant: 'new_academy', q: 'Was ist die Sonder-AfA nach §7b EStG?' },
  { tenant: 'new_academy', q: 'Welche KfW Förderung bekomme ich für ein EH40 Haus?' },
]

const pool = new pg.Pool({ connectionString: databaseUrl })
const repo = new PostgresKnowledgeRepository(pool)
let failed = 0
for (const testCase of CASES) {
  const hits = await repo.search(testCase.tenant, testCase.q, 3, MIN_SCORE)
  const top = hits[0]
  const scoreOk = Boolean(top) && top.score >= MIN_SCORE
  const titleOk = !testCase.title || (top && top.title.includes(testCase.title))
  const ok = scoreOk && titleOk
  if (!ok) failed += 1
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} | ${testCase.tenant} | ${testCase.q} => ` +
      (top ? `${top.score.toFixed(3)} ${top.title}` : 'kein Treffer'),
  )
}
await pool.end()
console.log(`ERGEBNIS: ${CASES.length - failed}/${CASES.length} bestanden (Schwelle ${MIN_SCORE})`)
process.exit(failed === 0 ? 0 : 1)
