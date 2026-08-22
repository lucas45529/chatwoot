-- Umlaut-Transliteration fuer die Wissenssuche: Kunden schreiben "Förderung",
-- viele Dokumente sind ASCII ("Foerderung") — oder umgekehrt. Der Suchvektor
-- traegt ab jetzt zusaetzlich eine ae/oe/ue/ss-normalisierte Kopie, damit die
-- OR-Suche beide Schreibweisen findet. Query-Seite: repository.ts (RELAXED_QUERY).
ALTER TABLE agent_knowledge_documents DROP COLUMN search_vector;

ALTER TABLE agent_knowledge_documents
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'german',
      coalesce(title, '') || ' ' || coalesce(content, '') || ' ' ||
      replace(replace(replace(replace(
        lower(coalesce(title, '') || ' ' || coalesce(content, '')),
        'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS agent_knowledge_documents_search_idx
  ON agent_knowledge_documents USING gin (search_vector);
