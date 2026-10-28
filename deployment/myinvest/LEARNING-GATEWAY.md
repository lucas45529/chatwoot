# Learning gateway rollout

The existing customer agent stays on its current image. The new service exposes
only signed `/learning` and read-only `/health`; it imports no delivery workers,
provider clients or messaging credentials.

## Identity and store

- PostgreSQL writer: new `mi_support_learning`, NOINHERIT/NOSUPERUSER/NOCREATEDB/
  NOCREATEROLE/NOREPLICATION. Apply `sql/learning-gateway-role.sql` in the agent
  database using one administrator transaction. It grants only knowledge
  candidate/document reads and writes, append-only learning audit, and durable
  nonce claims. It does not grant delivery, customer mail or schema modification privileges.
- Initialize one new login password in the protected gateway environment store;
  do not alter an existing role credential. If a role already exists without its
  owned protected store, stop and resolve ownership.
- Reuse the verified `agent_learning_ro` Chatwoot identity, which has SELECT on
  contacts/conversations/messages and no credential/user-table or write access.
- Derive the three tenant identity records from the existing live tenant config
  using `bootstrap/learning_source_identity.rb` in a read-only Rails transaction.
  Emit only key/accountId/inboxId/agentBotId; copy no bot/webhook/API tokens.

The root-only environment (0600 inside a 0700 secret directory) contains only
`DATABASE_URL`, `CHATWOOT_DATABASE_URL`, `SUPPORT_CHATWOOT_SSO_SECRET`,
`LEARNING_TENANTS_JSON`, `RUN_MODE=web`, `AUTO_SEND_ENABLED=false`, and optional
`PORT=8080`. Both current_user and session_user and prohibited privileges are
checked before listening. No Redis administrator credential is needed; replay
claims live in the new PostgreSQL nonce table.

## Prepare, verify and switch

1. Build the pinned agent Dockerfile from the reviewed source commit and label
   the immutable learning image with that exact revision. The compose command
   explicitly starts `dist/learning-server.js`.
2. Copy the currently mounted live Caddyfile to a new release directory through
   `scripts/prepare-learning-caddy.py`. The transformer changes only the one
   existing `/_agent/learning` upstream; it refuses absent/ambiguous routes.
   Never overwrite source-tree or previous release WIP.
3. Set the non-secret deployment references `LEARNING_GATEWAY_IMAGE`,
   `LEARNING_GATEWAY_ENV_FILE`, `LEARNING_GATEWAY_CADDYFILE`. Merge
   `compose-learning.yaml` after the exact currently active compose files.
4. Start only `support-learning` with `--no-deps`. Confirm actual UID10003,
   root filesystem read-only, caps dropped, no host port, backend network only,
   mode learning-only, customerSendEnabled false and database least privilege.
5. Before routing, test all three signed automatic/status requests directly
   against the sidecar and reject invalid HMAC/replay/unsupported tenant/action.
   Do not claim/evaluate/publish production candidates or send test messages.
6. Keep `LEARNING_GATEWAY_CADDYFILE` pinned to the currently mounted live file.
   Save its exact protected prestate, compare its current bytes/inode before
   writing, then write only the reviewed merged bytes to the same inode and
   fsync. An atomic rename would leave the running file bind mount on old data.
   Validate the complete merged Caddyfile before the write, then use a normal
   reload; restore the exact prestate in place if validation/reload fails. Re-read the live mounted file and verify the
   public signed status path. Confirm old customer agent image/start time is
   unchanged. Preserve all original compose files and the previous Caddyfile
   as the precise rollback reference.
