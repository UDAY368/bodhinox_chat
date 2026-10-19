-- Natural questions rarely contain only words present verbatim in a passage.
-- Keep the indexed lexical lookup, but match meaningful keywords independently.
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
    WHERE c.account_id=p_account_id AND c.fts @@ s.query
  )
  SELECT m.id,m.content,m.rank FROM matches m
  ORDER BY m.rank DESC,m.id LIMIT LEAST(GREATEST(p_match_count,0),100)
$$;
