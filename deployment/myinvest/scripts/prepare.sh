#!/usr/bin/env bash
set -Eeuo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_path="${ENV_FILE:-$deployment_dir/.env}"
if [[ -z "${CHATWOOT_BUILD_GIT_SHA:-}" ]]; then
  export CHATWOOT_BUILD_GIT_SHA="$("$deployment_dir/scripts/resolve-build-revision.sh")"
fi
compose=(docker compose --project-directory "$deployment_dir" --env-file "$env_path" -f "$deployment_dir/compose.yaml")

ALLOW_UNBOOTSTRAPPED_TENANTS=true "$deployment_dir/scripts/validate.sh"
"${compose[@]}" up -d postgres redis minio
"${compose[@]}" run --rm minio-init
# Chatwoot intentionally runs as a non-superuser; only this approved preparation
# step creates the extensions its schema requires.
# shellcheck disable=SC2016
"${compose[@]}" exec -T postgres sh -ec '
  PGPASSWORD="$POSTGRES_PASSWORD" psql --username "$POSTGRES_USER" --dbname "$CHATWOOT_DATABASE" <<SQL
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
SQL
'
# Reconcile application credentials before Rails connects. Docker volumes
# outlive container recreation, while a recovered or regenerated .env may not.
"${compose[@]}" exec -T postgres sh -ec "
  PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql --username \"\$POSTGRES_USER\" --dbname \"\$POSTGRES_DB\" \
    --set=chatwoot_role=\"\$CHATWOOT_DATABASE_USER\" \
    --set=chatwoot_password=\"\$CHATWOOT_DATABASE_PASSWORD\" \
    --set=agent_role=\"\$CLAUDE_AGENT_DATABASE_USER\" \
    --set=agent_password=\"\$CLAUDE_AGENT_DATABASE_PASSWORD\" <<'SQL'
SELECT format('ALTER ROLE %I WITH PASSWORD %L', :'chatwoot_role', :'chatwoot_password') \gexec
SELECT format('ALTER ROLE %I WITH PASSWORD %L', :'agent_role', :'agent_password') \gexec
SQL
"
"${compose[@]}" run --rm rails bundle exec rails db:chatwoot_prepare
"$deployment_dir/scripts/reconcile-readonly-role.sh"
"${compose[@]}" up -d rails sidekiq caddy
printf 'Chatwoot core services started; run scripts/bootstrap.sh to create tenants and start the Claude agent.\n'
