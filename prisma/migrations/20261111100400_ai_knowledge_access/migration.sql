-- Phase 13: permission-aware knowledge retrieval.
--
-- Each knowledge source gains who may see it (min_role: agents and above, or
-- admins only) and whether it may ground customer-facing text
-- (customer_facing). An admin-only source can never ground customer text
-- (pairing CHECK). Existing rows take the constant defaults (agent, true), so
-- nothing changes for existing users; constant defaults need no rewrite and
-- the table is small.
--
-- ai_knowledge_documents.tenant_read is replaced so an admin-only source's
-- documents are really hidden from agents (the browser data API reads
-- documents). Documents of 'agent' sources and documents without a source
-- (legacy typed documents) stay visible to every member exactly as before;
-- only an 'admin' source is narrowed. Admins still read everything (also
-- through tenant_write).
--
-- New SECURITY INVOKER retrieval RPCs take an audience instead of any
-- caller-supplied role: 'customer' returns only customer-facing,
-- agent-visible sources; 'staff' returns what the live session's role may
-- read and is refused to the worker (which passes every role check). The old
-- RPCs are no longer called by the app; they keep their signatures and
-- return shapes but are narrowed to the 'customer' audience (customer-facing,
-- agent-visible, not disabled) so a rolled-back or still-draining old
-- instance never grounds customer text on restricted knowledge.
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_knowledge_sources ADD COLUMN min_role text NOT NULL DEFAULT 'agent'
  CONSTRAINT ai_knowledge_sources_min_role_check CHECK (min_role IN ('agent','admin'));
ALTER TABLE ai_knowledge_sources ADD COLUMN customer_facing boolean NOT NULL DEFAULT true;
ALTER TABLE ai_knowledge_sources ADD CONSTRAINT ai_knowledge_sources_customer_role_check
  CHECK (NOT customer_facing OR min_role = 'agent');

DROP POLICY tenant_read ON ai_knowledge_documents;
CREATE POLICY tenant_read ON ai_knowledge_documents FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id() AND (source_id IS NULL OR EXISTS (
    SELECT 1 FROM ai_knowledge_sources s
    WHERE s.account_id = ai_knowledge_documents.account_id AND s.id = ai_knowledge_documents.source_id
      AND (s.min_role = 'agent' OR app_write_allowed(s.min_role)))));

CREATE FUNCTION match_ai_knowledge_fts_v2(p_account_id uuid, p_query text, p_match_count integer, p_audience text)
RETURNS TABLE(id uuid, document_id uuid, source_id uuid, content text, rank real)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF p_audience IS NULL OR p_audience NOT IN ('customer','staff') THEN
    RAISE EXCEPTION 'Invalid knowledge audience' USING ERRCODE = '22023';
  END IF;
  IF p_audience = 'staff' AND current_user = 'bodhinox_worker' THEN
    RAISE EXCEPTION 'The staff knowledge audience requires a member session' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH keywords AS MATERIALIZED (
    SELECT w.word FROM unnest(tsvector_to_array(to_tsvector('simple', left(COALESCE(p_query,''), 4000)))) AS w(word)
    WHERE w.word <> ALL (ARRAY[
      'a','an','and','are','as','at','be','been','but','by','can','could','did','do','does',
      'explain','for','from','had','has','have','how','i','if','in','is','it','its','me',
      'my','of','on','or','our','please','s','should','some','tell','than','that','the',
      'their','them','there','these','they','this','those','to','us','was','we','were',
      'what','when','where','which','who','why','will','with','would','you','your','about'
    ]::text[])
    ORDER BY w.word LIMIT 32
  ), search AS (
    -- quote_literal escapes apostrophes/backslashes; input cannot inject tsquery operators.
    SELECT to_tsquery('simple', string_agg(quote_literal(k.word), ' | ')) AS query FROM keywords k
  ), matches AS (
    SELECT c.id AS chunk_id, c.document_id AS doc_id, d.source_id AS src_id, c.content AS body,
      ((SELECT count(*) FROM keywords k WHERE c.fts @@ plainto_tsquery('simple', k.word)) +
       ts_rank(c.fts, s.query) / (1 + ts_rank(c.fts, s.query)))::real AS score
    FROM ai_knowledge_chunks c
    CROSS JOIN search s
    JOIN ai_knowledge_documents d ON d.account_id = c.account_id AND d.id = c.document_id
    LEFT JOIN ai_knowledge_sources src ON src.account_id = d.account_id AND src.id = d.source_id
    WHERE c.account_id = p_account_id AND p_account_id = app_account_id() AND c.fts @@ s.query
      AND (src.id IS NULL OR src.status <> 'disabled')
      AND CASE WHEN p_audience = 'customer'
        THEN (src.id IS NULL OR (src.customer_facing AND src.min_role = 'agent'))
        ELSE (src.id IS NULL OR app_write_allowed(src.min_role)) END
  )
  SELECT m.chunk_id, m.doc_id, m.src_id, m.body, m.score FROM matches m
  ORDER BY m.score DESC, m.chunk_id LIMIT LEAST(GREATEST(p_match_count, 0), 100);
END $$;

CREATE FUNCTION match_ai_knowledge_semantic_v2(p_account_id uuid, p_query_embedding text, p_match_count integer, p_audience text)
RETURNS TABLE(id uuid, document_id uuid, source_id uuid, content text, distance real)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF p_audience IS NULL OR p_audience NOT IN ('customer','staff') THEN
    RAISE EXCEPTION 'Invalid knowledge audience' USING ERRCODE = '22023';
  END IF;
  IF p_audience = 'staff' AND current_user = 'bodhinox_worker' THEN
    RAISE EXCEPTION 'The staff knowledge audience requires a member session' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT c.id, c.document_id, d.source_id, c.content, (c.embedding <=> p_query_embedding::vector(1536))::real
  FROM ai_knowledge_chunks c
  JOIN ai_knowledge_documents d ON d.account_id = c.account_id AND d.id = c.document_id
  LEFT JOIN ai_knowledge_sources src ON src.account_id = d.account_id AND src.id = d.source_id
  WHERE c.account_id = p_account_id AND p_account_id = app_account_id() AND c.embedding IS NOT NULL
    AND (src.id IS NULL OR src.status <> 'disabled')
    AND CASE WHEN p_audience = 'customer'
      THEN (src.id IS NULL OR (src.customer_facing AND src.min_role = 'agent'))
      ELSE (src.id IS NULL OR app_write_allowed(src.min_role)) END
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT LEAST(GREATEST(p_match_count, 0), 100);
END $$;

REVOKE ALL ON FUNCTION match_ai_knowledge_fts_v2(uuid, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION match_ai_knowledge_semantic_v2(uuid, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION match_ai_knowledge_fts_v2(uuid, text, integer, text),
  match_ai_knowledge_semantic_v2(uuid, text, integer, text) TO bodhinox_app, bodhinox_worker;

CREATE OR REPLACE FUNCTION match_ai_knowledge_fts(p_account_id uuid,p_query text,p_match_count integer)
RETURNS TABLE(id uuid,content text,rank real) LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH keywords AS MATERIALIZED (
    SELECT word FROM unnest(tsvector_to_array(to_tsvector('simple',left(COALESCE(p_query,''),4000)))) AS words(word)
    WHERE word <> ALL (ARRAY[
      'a','an','and','are','as','at','be','been','but','by','can','could','did','do','does',
      'explain','for','from','had','has','have','how','i','if','in','is','it','its','me',
      'my','of','on','or','our','please','s','should','some','tell','than','that','the',
      'their','them','there','these','they','this','those','to','us','was','we','were',
      'what','when','where','which','who','why','will','with','would','you','your','about'
    ]::text[])
    ORDER BY word LIMIT 32
  ), search AS (
    -- quote_literal escapes apostrophes/backslashes; input cannot inject tsquery operators.
    SELECT to_tsquery('simple',string_agg(quote_literal(word),' | ')) AS query FROM keywords
  ), matches AS (
    SELECT c.id,c.content,
      ((SELECT count(*) FROM keywords k WHERE c.fts @@ plainto_tsquery('simple',k.word)) +
       ts_rank(c.fts,s.query) / (1 + ts_rank(c.fts,s.query)))::real AS rank
    FROM ai_knowledge_chunks c CROSS JOIN search s
    JOIN ai_knowledge_documents d ON d.account_id=c.account_id AND d.id=c.document_id
    LEFT JOIN ai_knowledge_sources src ON src.account_id=d.account_id AND src.id=d.source_id
    WHERE c.account_id=p_account_id AND c.fts @@ s.query
      AND (src.id IS NULL OR (src.customer_facing AND src.min_role='agent' AND src.status <> 'disabled'))
  )
  SELECT m.id,m.content,m.rank FROM matches m
  ORDER BY m.rank DESC,m.id LIMIT LEAST(GREATEST(p_match_count,0),100)
$$;

CREATE OR REPLACE FUNCTION match_ai_knowledge_semantic(p_account_id uuid,p_query_embedding text,p_match_count integer)
RETURNS TABLE(id uuid,content text,distance real) LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT c.id,c.content,(c.embedding <=> p_query_embedding::vector(1536))::real FROM ai_knowledge_chunks c
  JOIN ai_knowledge_documents d ON d.account_id=c.account_id AND d.id=c.document_id
  LEFT JOIN ai_knowledge_sources src ON src.account_id=d.account_id AND src.id=d.source_id
  WHERE c.account_id=p_account_id AND c.embedding IS NOT NULL
    AND (src.id IS NULL OR (src.customer_facing AND src.min_role='agent' AND src.status <> 'disabled'))
  ORDER BY c.embedding <=> p_query_embedding::vector(1536) LIMIT LEAST(GREATEST(p_match_count,0),100)
$$;
