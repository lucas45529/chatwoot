#!/usr/bin/env bash
# support-report.sh — Woechentliche Support-Analyse:
#   1. Volumen je Inbox/Kanal (letzte 30 Tage)
#   2. Bot-Leistung: automatisch beantwortet vs. uebergeben (Agent-DB)
#   3. Top-Themen der Kundenfragen (Schluesselwort-Klassifikation)
#   4. Haeufigste Einzelfragen (normalisiert, dedupliziert)
#   5. Handoffs nach Grund + Retrieval-Miss-Fragen (Agent-Logs)
#   6. Lern-Kandidaten in der Review-Warteschlange
#
# Ablage unter ~/support-reports/YYYY-KW.txt.
# Cron (host, admin): 12 7 * * 1 ~/chatwoot-migration/chatwoot/deployment/myinvest/scripts/support-report.sh
set -euo pipefail

cd "$(dirname "$0")/.."
OUT_DIR="$HOME/support-reports"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$(date +%G-W%V).txt"

set -a; . ./.env; set +a
AGENT_PSQL=(docker compose exec -T postgres psql "$CLAUDE_AGENT_DATABASE_URL" -t)
CHATWOOT_PSQL=(docker compose exec -T postgres psql "$AGENT_LEARNING_CHATWOOT_DATABASE_URL" -t)
LOGS=$(docker compose logs claude-agent --since 168h --no-log-prefix 2>/dev/null || true)

{
  echo "Support-Report KW $(date +%G-W%V) — erstellt $(date '+%d.%m.%Y %H:%M')"
  echo "============================================================"
  echo
  echo "== 1. Volumen je Inbox (letzte 30 Tage) =="
  "${CHATWOOT_PSQL[@]}" -c \
    "SELECT i.name, count(DISTINCT c.id) AS konversationen, count(m.id) AS nachrichten
       FROM conversations c
       JOIN inboxes i ON i.id = c.inbox_id
       LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.created_at > now() - interval '30 days'
      GROUP BY 1 ORDER BY 2 DESC;" 2>/dev/null || echo "(Chatwoot-DB nicht erreichbar)"
  echo
  echo "== 2. Bot-Leistung (letzte 30 Tage) =="
  "${AGENT_PSQL[@]}" -c \
    "SELECT CASE status WHEN 'replied' THEN 'automatisch beantwortet' WHEN 'handed_off' THEN 'an Menschen uebergeben' ELSE status END,
            count(*)
       FROM agent_delivery_ledger
      WHERE updated_at > now() - interval '30 days' AND status IN ('replied','handed_off')
      GROUP BY 1 ORDER BY 2 DESC;" 2>/dev/null || echo "(Agent-DB nicht erreichbar)"
  echo
  echo "== 3. Top-Themen der Kundenfragen (letzte 30 Tage) =="
  "${CHATWOOT_PSQL[@]}" -c \
    "SELECT CASE
              WHEN content ~* '(k.ndig|vertrag|widerruf|laufzeit)' THEN 'Kuendigung/Vertrag'
              WHEN content ~* '(preis|kosten|geb.hr|abo[^a-z]|teuer|billig|zahlung|rechnung)' THEN 'Preis/Abo/Zahlung'
              WHEN content ~* '(login|passwort|anmeld|zugang|einlogg|registrier)' THEN 'Login/Zugang'
              WHEN content ~* '(afa|abschreib|steuer|denkmal|7b)' THEN 'AfA/Steuern'
              WHEN content ~* '(kfw|f.rder|zuschuss|eh40|qng|kredit)' THEN 'KfW/Foerderung'
              WHEN content ~* '(rendite|berechn|cashflow|kalkul|finanzier)' THEN 'Rendite/Finanzierung'
              WHEN content ~* '(l.sch|datenschutz|dsgvo)' THEN 'Datenschutz/Loeschung'
              WHEN content ~* '(termin|beratung|anruf|demo|r.ckruf|kontakt)' THEN 'Termin/Beratung'
              WHEN content ~* '(funktionier|einstellung|feature|export|import|dashboard|app|software)' THEN 'Bedienung/Software'
              ELSE 'Sonstiges' END AS thema,
            count(*) AS fragen
       FROM messages
      WHERE message_type = 0 AND sender_type = 'Contact' AND NOT private
        AND created_at > now() - interval '30 days' AND length(content) > 15
      GROUP BY 1 ORDER BY 2 DESC;" 2>/dev/null || echo "(Chatwoot-DB nicht erreichbar)"
  echo
  echo "== 4. Haeufigste Einzelfragen (letzte 30 Tage, Top 15) =="
  "${CHATWOOT_PSQL[@]}" -c \
    "SELECT count(*) AS anzahl, left(norm.frage, 110) AS frage
       FROM (SELECT lower(regexp_replace(content, '[[:punct:][:space:]]+', ' ', 'g')) AS frage
               FROM messages
              WHERE message_type = 0 AND sender_type = 'Contact' AND NOT private
                AND created_at > now() - interval '30 days' AND length(content) > 15) norm
      GROUP BY norm.frage HAVING count(*) > 1 ORDER BY 1 DESC LIMIT 15;" 2>/dev/null || echo "(Chatwoot-DB nicht erreichbar)"
  echo
  echo "== 5a. Handoffs nach Grund (letzte 7 Tage) =="
  printf '%s\n' "$LOGS" | grep '"event":"agent_handoff"' \
    | jq -r '.reason' | sort | uniq -c | sort -rn || echo "(keine Handoffs)"
  echo
  echo "== 5b. Retrieval-Miss-Fragen: DAFUER FEHLT WISSEN (Top 50) =="
  printf '%s\n' "$LOGS" | grep '"event":"agent_handoff"' \
    | jq -r 'select(.reason=="retrieval_miss") | .detail' \
    | sed -E 's/.*question="(.*)"/\1/' \
    | sort | uniq -c | sort -rn | head -50 || echo "(keine)"
  echo
  echo "== 5c. Antwortfehler =="
  printf '%s\n' "$LOGS" | grep '"event":"agent_answer_failed"' || echo "(keine)"
  echo
  echo "== 6. Lern-Kandidaten (Review-Warteschlange) =="
  "${AGENT_PSQL[@]}" -c \
    "SELECT status, count(*) FROM agent_knowledge_candidates WHERE status IN ('quarantined','pending_review') GROUP BY 1;
     SELECT '#' || id || ' [' || status || '] ' || left(question_redacted, 100) FROM agent_knowledge_candidates WHERE status IN ('quarantined','pending_review') ORDER BY id DESC LIMIT 10;" \
    2>/dev/null || echo "(Agent-DB nicht erreichbar)"
} > "$OUT"

echo "Report: $OUT"
