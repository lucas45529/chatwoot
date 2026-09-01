#!/usr/bin/env bash
set -Eeuo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_path="${ENV_FILE:-$deployment_dir/.env}"
compose=(docker compose --project-directory "$deployment_dir" --env-file "$env_path" -f "$deployment_dir/compose.yaml")

"${compose[@]}" exec -T postgres sh -ec "
  PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql --username \"\$POSTGRES_USER\" --dbname \"\$CHATWOOT_DATABASE\" \
    --set=database=\"\$CHATWOOT_DATABASE\" \
    --set=application_role=\"\$CHATWOOT_DATABASE_USER\" \
    --set=readonly_role=\"\$AGENT_LEARNING_DATABASE_USER\" \
    --set=readonly_password=\"\$AGENT_LEARNING_DATABASE_PASSWORD\" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
  :'readonly_role',
  :'readonly_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'readonly_role') \gexec
SELECT format('ALTER ROLE %I WITH PASSWORD %L', :'readonly_role', :'readonly_password') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database', :'readonly_role') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE CREATE ON SCHEMA public FROM %I', :'readonly_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'readonly_role') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', :'readonly_role') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', :'readonly_role') \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE SELECT ON TABLES FROM %I',
  :'application_role',
  :'readonly_role'
) \gexec
SELECT format(
  'GRANT SELECT ON TABLE messages, conversations, contacts TO %I',
  :'readonly_role'
) \gexec
SELECT format('ALTER ROLE %I SET default_transaction_read_only = on', :'readonly_role') \gexec
SQL
"
