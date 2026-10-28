-- Run as the PostgreSQL owner in the existing agent database, in one transaction.
-- New login credentials are initialized separately in the protected gateway store.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mi_support_learning') THEN
    CREATE ROLE mi_support_learning NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mi_support_learning'
    AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'Existing learning role has unexpected privileges';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mi_support_learning', current_database());
END
$role$;

CREATE TABLE IF NOT EXISTS agent_learning_request_nonces (
  request_key text PRIMARY KEY CHECK (request_key ~ '^support-learning:v1:[0-9a-f-]{36}$'),
  expires_at timestamptz NOT NULL
);
REVOKE ALL ON agent_learning_request_nonces FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO mi_support_learning;
GRANT SELECT, INSERT, UPDATE ON agent_knowledge_candidates, agent_knowledge_documents,
  agent_learning_request_nonces TO mi_support_learning;
GRANT SELECT, INSERT ON agent_learning_audit_events TO mi_support_learning;
DO $sequences$
DECLARE sequence_name text;
BEGIN
  FOR sequence_name IN SELECT pg_get_serial_sequence(table_name, 'id')
    FROM unnest(ARRAY['agent_knowledge_candidates', 'agent_knowledge_documents', 'agent_learning_audit_events']) AS table_name
  LOOP
    IF sequence_name IS NOT NULL THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO mi_support_learning', sequence_name);
    END IF;
  END LOOP;
END
$sequences$;
