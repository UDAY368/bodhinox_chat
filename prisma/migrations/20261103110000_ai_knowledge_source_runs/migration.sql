-- Fences knowledge-source runs: only the job whose payload runId equals
-- current_run_id may change the source or its pages. Set in the same
-- transaction that queues the run (create, re-crawl, re-index); a run that is
-- replaced after a stale restart stops at its next check. Additive and nullable.
ALTER TABLE ai_knowledge_sources ADD COLUMN current_run_id uuid;
