// Executed through stdin inside claude-agent; its pg dependency and existing
// DATABASE_URL / read-only CHATWOOT_DATABASE_URL never leave the container.
const { Pool } = require('pg');

async function report() {
  if (!process.env.DATABASE_URL || !process.env.CHATWOOT_DATABASE_URL) {
    throw new Error('Report database configuration missing');
  }
  const agent = new Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 30000, connectionTimeoutMillis: 10000 });
  const chatwoot = new Pool({ connectionString: process.env.CHATWOOT_DATABASE_URL, statement_timeout: 30000, connectionTimeoutMillis: 10000 });
  try {
    // Inbox names and individual question text are user-controlled; report only
    // numeric routing identifiers, fixed categories and database aggregates.
    const volume = await chatwoot.query(`
      SELECT c.account_id, c.inbox_id, count(DISTINCT c.id) AS conversations, count(m.id) AS messages
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id AND m.account_id = c.account_id
      WHERE c.created_at > now() - interval '30 days'
      GROUP BY c.account_id, c.inbox_id ORDER BY conversations DESC`);
    const deliveries = await agent.query(`
      SELECT status, count(*) AS deliveries
      FROM agent_delivery_ledger
      WHERE updated_at > now() - interval '30 days' AND status IN ('replied', 'handed_off')
      GROUP BY status ORDER BY deliveries DESC`);
    const topics = await chatwoot.query(`
      SELECT CASE
        WHEN content ~* '(k.ndig|vertrag|widerruf|laufzeit)' THEN 'Kuendigung/Vertrag'
        WHEN content ~* '(preis|kosten|geb.hr|abo[^a-z]|teuer|billig|zahlung|rechnung)' THEN 'Preis/Abo/Zahlung'
        WHEN content ~* '(login|passwort|anmeld|zugang|einlogg|registrier)' THEN 'Login/Zugang'
        WHEN content ~* '(afa|abschreib|steuer|denkmal|7b)' THEN 'AfA/Steuern'
        WHEN content ~* '(kfw|f.rder|zuschuss|eh40|qng|kredit)' THEN 'KfW/Foerderung'
        WHEN content ~* '(rendite|berechn|cashflow|kalkul|finanzier)' THEN 'Rendite/Finanzierung'
        WHEN content ~* '(l.sch|datenschutz|dsgvo)' THEN 'Datenschutz/Loeschung'
        WHEN content ~* '(termin|beratung|anruf|demo|r.ckruf|kontakt)' THEN 'Termin/Beratung'
        WHEN content ~* '(funktionier|einstellung|feature|export|import|dashboard|app|software)' THEN 'Bedienung/Software'
        ELSE 'Sonstiges' END AS topic, count(*) AS questions
      FROM messages
      WHERE message_type = 0 AND sender_type = 'Contact' AND NOT private
        AND created_at > now() - interval '30 days' AND length(content) > 15
      GROUP BY topic ORDER BY questions DESC`);
    const candidates = await agent.query(`
      SELECT status, count(*) AS candidates
      FROM agent_knowledge_candidates
      WHERE status IN ('quarantined', 'pending_review')
      GROUP BY status ORDER BY status`);

    const sections = [
      ['Volumen je Account/Inbox (Konversationen der letzten 30 Tage)', volume.rows],
      ['Bot-Leistung (letzte 30 Tage)', deliveries.rows],
      ['Themen der Kundenfragen (letzte 30 Tage)', topics.rows],
      ['Lern-Kandidaten in der Review-Warteschlange', candidates.rows],
    ];
    const lines = [`Support-Report — erstellt ${new Date().toISOString()}`];
    for (const [title, rows] of sections) {
      lines.push('', `== ${title} ==`, rows.length ? JSON.stringify(rows) : '(keine)');
    }
    // Publish nothing until every query has succeeded. Never inspect raw logs.
    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    await Promise.all([agent.end(), chatwoot.end()]);
  }
}

report().catch(() => {
  process.stderr.write('Support report query failed.\n');
  process.exitCode = 1;
});
