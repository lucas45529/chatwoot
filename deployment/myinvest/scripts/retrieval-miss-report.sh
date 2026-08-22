#!/usr/bin/env bash
# retrieval-miss-report.sh — Welche Kundenfragen fanden kein Wissen?
#
# Der claude-agent loggt jeden Handoff als JSON-Zeile (event=agent_handoff),
# bei retrieval_miss inkl. der gekuerzten Kundenfrage. Dieser Report wertet die
# letzten 7 Tage aus und legt sie unter ~/retrieval-miss-reports/ ab — die
# Top-Fragen sind die naechsten zu schreibenden Wissensartikel.
#
# Cron (host, admin): 12 7 * * 1 ~/chatwoot-migration/chatwoot/deployment/myinvest/scripts/retrieval-miss-report.sh
set -euo pipefail

cd "$(dirname "$0")/.."
OUT_DIR="$HOME/retrieval-miss-reports"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$(date +%G-W%V).txt"

LOGS=$(docker compose logs claude-agent --since 168h --no-log-prefix 2>/dev/null || true)

{
  echo "Retrieval-Report KW $(date +%G-W%V) — letzte 7 Tage"
  echo "==================================================="
  echo
  echo "== Handoffs nach Grund =="
  printf '%s\n' "$LOGS" | grep '"event":"agent_handoff"' \
    | jq -r '.reason' | sort | uniq -c | sort -rn || echo "(keine Handoffs)"
  echo
  echo "== Retrieval-Miss-Fragen (Top 50, dedupliziert) =="
  printf '%s\n' "$LOGS" | grep '"event":"agent_handoff"' \
    | jq -r 'select(.reason=="retrieval_miss") | .detail' \
    | sed -E 's/.*question="(.*)"/\1/' \
    | sort | uniq -c | sort -rn | head -50 || echo "(keine)"
  echo
  echo "== Antwortfehler =="
  printf '%s\n' "$LOGS" | grep '"event":"agent_answer_failed"' || echo "(keine)"
  echo
  echo "== Lern-Kandidaten (Review-Warteschlange) =="
  set -a; . ./.env; set +a
  docker compose exec -T postgres psql -U "$CLAUDE_AGENT_DATABASE_USER" -d "$CLAUDE_AGENT_DATABASE_NAME" -t -c \
    "SELECT status, count(*) FROM agent_knowledge_candidates WHERE status IN ('quarantined','pending_review') GROUP BY 1;
     SELECT '#' || id || ' [' || status || '] ' || left(question_redacted, 100) FROM agent_knowledge_candidates WHERE status IN ('quarantined','pending_review') ORDER BY id DESC LIMIT 10;" \
    2>/dev/null || echo "(Agent-DB nicht erreichbar)"
} > "$OUT"

echo "Report: $OUT"
