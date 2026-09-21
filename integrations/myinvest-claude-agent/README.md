# MyInvest Support Agent for Chatwoot

Der Dienst verbindet die drei getrennten Chatwoot-Accounts mit **einem**
Support-Gehirn: `POST https://www.myinvest-pro.de/api/support/answer`.
Der Agent hat kein eigenes Modell und kein eigenes Retrieval mehr. Er prüft
signierte Chatwoot-Webhooks, projiziert den begrenzten Gesprächsverlauf,
transportiert die signierte Anfrage und setzt das serverseitige Urteil um.

## Sicherheits- und Mandantengrenzen

- `saas`, `new_academy` und `legacy_academy` haben getrennte Account-IDs,
  Webhook-Secrets und AgentBot-Tokens. Jeder Gehirn-Aufruf trägt genau einen
  `tenant`; Tests halten den Negativpfad.
- Gehirn-Auth: HMAC-SHA256 über `${timestamp}.${requestId}.${rawBody}` mit
  `SUPPORT_ANSWER_SECRET`; Header für Signatur, Zeitstempel und UUID. Der
  Server beansprucht jede UUID dauerhaft. 4xx wird nie wiederholt;
  Netz/5xx genau einmal mit neuer UUID.
  Antworten werden vor dem Einlesen begrenzt und strikt mit Zod validiert.
- Die Website entscheidet `safeToAutoSend`; der Agent kann es nie selbst
  hochstufen. Zusätzlich gelten Kill-Switch, finale Live-Prüfung von Chatwoot
  und AgentState, dauerhafte Sperre nach jeder Menschenantwort sowie atomare
  Obergrenzen je Konversation und Kontakt/Stunde. Eine Transaktionsreservierung
  steht vor jedem öffentlichen Send.
- Sicherheits-, Geld-, Vertrags-, Rechts-, Steuer-, Datenschutz- und explizite
  Menschenanliegen bleiben beim Team. Unsichere oder abgelehnte Antworten
  werden Entwurf oder Übergabe, nie erfundene Kundenantwort.
- Chatwoot-HMAC, Zeitfenster und Delivery-IDs werden vor der Queue geprüft.
  Redis dedupliziert; PostgreSQL hält Zustell-, Handoff- und Auto-Send-Ledger
  über Neustarts.

## Gehirn-Konfiguration

```dotenv
SUPPORT_ANSWER_URL=https://www.myinvest-pro.de
SUPPORT_ANSWER_SECRET=<mindestens 32 Zeichen, identisch zur Website>
SUPPORT_ANSWER_TIMEOUT_MS=25000
PSEUDONYMIZATION_KEY=<unabhaengiger Schluessel mit mindestens 32 Zeichen>
AUTO_SEND_ENABLED=false
AUTO_SEND_MAX_PER_CONVERSATION=3
AUTO_SEND_MAX_PER_CONTACT_PER_HOUR=10
AUTO_SEND_FEEDBACK_INTERVAL_SECONDS=600
WHATSAPP_INBOX_IDS=6
```

`SUPPORT_ANSWER_URL` ist in Produktion HTTPS und eine reine Origin ohne Pfad,
Credentials, Query oder Fragment. `PSEUDONYMIZATION_KEY` ist ein eigener,
von allen Signatur- und Tenant-Secrets verschiedener HMAC-Schlüssel für
domain-separierte Kontakt- und Fragepseudonyme. `AUTO_SEND_ENABLED=false`
ist der sichere Default; die übrigen Bremsen gelten auch nach dem Einschalten.

## Bootstrap

1. Die Deployment-`.env` setzen; `bootstrap.sh` erstellt die drei
   Account-Zuordnungen ohne Credential-Ausgabe.
2. `pnpm migrate` gegen die getrennte `claude_agent`-Datenbank ausführen
   (der Container-Entrypoint tut dies idempotent).
3. `pnpm check && pnpm test && pnpm build`.
4. Deployment-Gate:

   ```sh
   deployment/myinvest/scripts/validate.sh
   docker compose up -d --build claude-agent
   ```

Die lokale Knowledge-Ingest-/Review-Pipeline bleibt ausschließlich für
auditierte Lernkandidaten bestehen. Sie erzeugt **keine** Runtime-Antworten;
Antwortwissen lebt im Website-Korpus.

Nie Kundenexporte, Secrets oder generierte `.env`-Dateien committen.

## Reviewed learning loop

HubSpot v2 history bundles remain separate from active knowledge. Candidate extraction verifies
the bundle manifest and message digest, pairs historical questions with human answers, removes
common personal identifiers, rejects sensitive/attachment-based pairs, and writes every result
with `target_tenant = NULL` and `status = quarantined`. The reviewed export-to-tenant mapping is
then applied without publishing:

```sh
pnpm learning:extract -- /private/hubspot-v2-bundle
pnpm learning:refresh-redaction -- /private/hubspot-v2-bundle
pnpm learning:classify-history -- scripts/history-learning-tenants.json
pnpm learning:review -- approve 42 legacy_academy reviewer-id
pnpm learning:review -- publish 42 reviewer-id
```

Historische Kandidaten behalten den getrennten Approve-/Publish-Gate. Der
tägliche `learning:mine`-Lauf extrahiert echte Kunde-zu-Mensch-Paare mit PII-,
Secret-, Sensitiv- und Wiederverwendungs-Schutz. Auto-Send hat einen eigenen
Nachlauf: Antwort ohne menschliche Korrektur und danach gelöst = hilfreiches
Signal; eine zeitnahe Menschenantwort = Korrektursignal. Beides bleibt
auditiert.

Der Website-Antwortpfad ruft passende veröffentlichte Beispiele über den
signierten `/_agent/learning`-Endpunkt ab. Produkt, Kandidat, aktives Dokument,
Inhalts-Hash und Freigabenachweis müssen zusammenpassen. Ein Datenbankstatus
allein ist keine Wissensfreigabe. Negative Signale und Redaction-Refresh
ziehen betroffene Beispiele zurück.

## Automatic correction learning

The Website's hourly scheduler invokes the existing signed learning endpoint
with `action: automatic` and `operation: claim | complete | status`. The host
discovers a public customer question, its bound private bot draft and a sent
human correction. It excludes automation, private-document replies, unchanged
copies, personal data and sensitive or individual commitments. A source hash
binds message identities, tenant, immutable content and sanitized history;
normal sent/delivered/read progress does not change it. Source resolution is
repeated before publication.

One expiring lease per tenant prevents parallel adoption. The Website proposes
a general example and performs real baseline/candidate answer comparisons.
The host independently validates grounded evidence, four complete comparisons,
absolute quality floors, no regressions, improvement for original and variant,
and proposal/source hashes. Successful candidates become active knowledge;
due rechecks can retire them. Human edits or rejection always take precedence.
No model output expands tool or sending privileges.

This implementation reuses the existing candidate, document and audit tables;
it adds no migration. Deploy the agent together with the matching Website build.
Do not apply production migrations as part of this release. The Website's
staged build permits manual proof; its hourly production cron starts only
after the separately approved production promotion.

Local verification: `pnpm check && pnpm test`. Setting
`LEARNING_TEST_DATABASE_URL` to a disposable PostgreSQL database also runs
source binding and publication/recheck/revocation integration tests. Never
point that test variable at production. The Website's fictional chat preview
uses an in-memory sink, has no customer identity, and cannot publish real
knowledge or send a customer message.
