# MyInvest Support Agent for Chatwoot

This service connects the account-scoped `MyInvest Support` AgentBot to Gemini. It verifies signed webhooks, reads a short PII-redacted conversation context, retrieves tenant-approved knowledge, and places substantive responses into Chatwoot's shared composer draft for human approval. Only deterministic greetings and safety acknowledgements are sent automatically.

## Isolation and handoff

- `saas`, `new_academy`, and `legacy_academy` have independent Chatwoot account IDs, webhook secrets, bot tokens, and knowledge rows.
- Every retrieval query requires `tenant_key`; tests guard the negative cross-tenant path.
- Missing identity or an under-specified follow-up can produce one source-free, fact-free clarification draft; unsupported first messages and every sensitive topic open the conversation for a human.
- Chatwoot HMAC, timestamp freshness, and delivery IDs are verified before queuing. Redis deduplicates deliveries for 24 hours; PostgreSQL keeps the durable reply, draft, and handoff ledger across restarts.

## Provider

Use `ANTHROPIC_PROVIDER=bedrock` with an EU regional/Geo-EU Bedrock inference profile for EU processing. Direct Anthropic (`ANTHROPIC_PROVIDER=direct`) is supported, but its data-processing region and DPA must be reviewed separately before production use. `provider-check` performs one real, non-customer inference and prints no provider response.

For an internal OpenAI-compatible server, use `ANTHROPIC_PROVIDER=local` together with
`LOCAL_LLM_BASE_URL=http://<internal-host>:<port>/v1`, `LOCAL_LLM_MODEL`, and an exact
`LOCAL_LLM_ALLOWED_HOSTS` entry. Only explicitly allowlisted private IPs, Docker service names,
or internal hostnames are accepted; redirects, metadata/public targets, URL credentials, and
non-`/v1` paths are rejected. `LOCAL_LLM_API_KEY` is optional for a network-isolated endpoint.
Requests are time-bounded and send `stream:false` plus `think:false` for deterministic Ollama JSON.

For Google Gemini, use `ANTHROPIC_PROVIDER=gemini` with `GEMINI_API_KEY`. The client talks to the
OpenAI-compatible endpoint pinned to `https://generativelanguage.googleapis.com/v1beta/openai`
(`GEMINI_BASE_URL` must match exactly; other hosts, plain HTTP, credentials, and query/fragment
parts are rejected). `GEMINI_MODEL` defaults to `gemini-3.7-flash`, and `GEMINI_THINKING_EFFORT`
(`low`/`medium`/`high`, default `high`) is sent as `reasoning_effort`. `GEMINI_TIMEOUT_MS` bounds
each request like the local provider. `GEMINI_MAX_TOKENS` (default 4096) must cover both thinking
and answer tokens, because the endpoint counts thinking against `max_tokens`. Gemini processing is
US-based; review the processing region and DPA before production use.

## Bootstrap

1. Use the deployment stack's `.env`; `bootstrap.sh` creates all three account mappings without printing credentials.
2. Run `pnpm migrate` once against the separate `claude_agent` database (the container entrypoint does this idempotently).
3. Ingest approved material independently:

   ```sh
   pnpm ingest -- saas saas-help ./knowledge/saas
   pnpm ingest -- new_academy academy-website ./knowledge/academy-neu
   pnpm ingest -- legacy_academy legacy-public-site ./knowledge/academy-alt
   ```

   The authoritative inputs are the SaaS `FAQ_CATEGORIES` content from
   `App_MyInvestPro/apps/web/components/help/help-sidebar.tsx`, the new Academy's reviewed
   `Website_Software_MyInvestPro/knowledge/*.txt` files, and the public legacy Academy
   `https://www.myinvest24.de/llms-full.txt`. Prepare them as explicit `.md`/`.txt` source
   directories; the ingest command rejects customer-history bundles, JSON/NDJSON, hidden
   files, symlinks, control bytes, and files above 5 MB. Re-ingestion retires only the named
   tenant/source namespace and cannot erase other sources or learned documents.

4. Bootstrap creates one account-scoped Agent Bot per account, points it to the public signed `/_agent/webhooks/chatwoot` endpoint, and attaches it only to that account's managed website inbox.

Never put customer exports, secrets, or generated `.env` files into Git.

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

Historic HubSpot candidates always retain the separate approve/publish gate. New live support
answers have a stronger approval signal: a human reviewed or edited the AI draft and actually
pressed Send. The daily `learning:mine` loop extracts every customer-to-human pair, applies the
same PII, secret, sensitive-topic and non-reusable-clarification guards, then records separate
audited approve and publish transitions under actor `chatwoot-human-send`. Retrieval sees only
`published` and `active` documents for the current tenant. Negative feedback immediately retires a
linked learned document and leaves a review/audit trail. A redaction refresh forces reviewed rows
back through review; unsafe legacy rows are rejected, never deleted or silently promoted.
