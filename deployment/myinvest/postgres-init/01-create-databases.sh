#!/usr/bin/env bash
set -Eeuo pipefail

validate_identifier() {
  local value="$1"
  local label="$2"
  if [[ ! "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    printf 'Invalid PostgreSQL identifier for %s\n' "$label" >&2
    exit 1
  fi
}

validate_identifier "$CHATWOOT_DATABASE" CHATWOOT_DATABASE
validate_identifier "$CHATWOOT_DATABASE_USER" CHATWOOT_DATABASE_USER
validate_identifier "$CLAUDE_AGENT_DATABASE" CLAUDE_AGENT_DATABASE
validate_identifier "$CLAUDE_AGENT_DATABASE_USER" CLAUDE_AGENT_DATABASE_USER
validate_identifier "$AGENT_LEARNING_DATABASE_USER" AGENT_LEARNING_DATABASE_USER

create_role_and_database() {
  local database="$1"
  local username="$2"
  local password="$3"

  psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set=database="$database" --set=username="$username" --set=password="$password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'username', :'password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'username') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'database', :'username')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'database') \gexec
SQL
}

create_readonly_role() {
  local username="$1"
  local password="$2"

  psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set=database="$CHATWOOT_DATABASE" --set=username="$username" --set=password="$password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION', :'username', :'password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'username') \gexec
SELECT format('ALTER ROLE %I WITH PASSWORD %L', :'username', :'password') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database', :'username') \gexec
SQL
}

create_role_and_database "$CHATWOOT_DATABASE" "$CHATWOOT_DATABASE_USER" "$CHATWOOT_DATABASE_PASSWORD"
create_role_and_database "$CLAUDE_AGENT_DATABASE" "$CLAUDE_AGENT_DATABASE_USER" "$CLAUDE_AGENT_DATABASE_PASSWORD"
create_readonly_role "$AGENT_LEARNING_DATABASE_USER" "$AGENT_LEARNING_DATABASE_PASSWORD"

PGPASSWORD="$POSTGRES_PASSWORD" psql --username "$POSTGRES_USER" --dbname "$CHATWOOT_DATABASE" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
SQL

PGPASSWORD="$POSTGRES_PASSWORD" psql --username "$POSTGRES_USER" --dbname "$CHATWOOT_DATABASE" \
  --set=readonly_role="$AGENT_LEARNING_DATABASE_USER" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE CREATE ON SCHEMA public FROM %I', :'readonly_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'readonly_role') \gexec
SELECT format('ALTER ROLE %I SET default_transaction_read_only = on', :'readonly_role') \gexec
SQL
