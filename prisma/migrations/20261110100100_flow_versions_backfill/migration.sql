-- Phase 12: give every live flow a version 1 and pin its active runs. Data only.
--
-- Targets: every flow without a version that is 'active' or 'paused', and
-- every plan-archived flow (plan_archives kind 'flows', prior_state 'active',
-- not restored) that billing restore() would bring back as 'active'. Version
-- 1 is the flow's current draft, which is what those flows run today.
-- Active runs of active or paused flows are pinned to that version. Draft
-- test-number runs and runs of draft or user-archived flows keep
-- flow_version_id NULL and behave exactly as before.
--
-- Idempotent (published_version_id IS NULL / flow_version_id IS NULL): the
-- deployment runbook re-runs this file once after the deploy, because old app
-- instances can activate a flow or start a run without a version during the
-- deploy window.
--
-- FORCE ROW LEVEL SECURITY applies to the table owner too. The owner-only
-- policies flow_versions_backfill_owner (20261110100000) plus the existing
-- owner reads let this file write as the owner without relaxing FORCE RLS,
-- so it takes only ROW EXCLUSIVE / ACCESS SHARE locks: the flow engine keeps
-- reading and writing flows and runs while it runs. lock_timeout (local to
-- this transaction) still makes a busy deploy fail fast instead of queueing.
SET LOCAL lock_timeout = '5s';

WITH targets AS (
  SELECT f.account_id, f.id, f.trigger_type, f.trigger_config, f.entry_node_id, f.fallback_policy, f.channel_scope
  FROM flows f
  WHERE f.published_version_id IS NULL
    AND (f.status IN ('active','paused')
      OR (f.status = 'archived' AND EXISTS (
        SELECT 1 FROM plan_archives pa
        WHERE pa.account_id = f.account_id AND pa.kind = 'flows' AND pa.item_id = f.id
          AND pa.prior_state = 'active' AND pa.restored_at IS NULL)))
), ins AS (
  INSERT INTO flow_versions (account_id, flow_id, version, trigger_type, trigger_config, entry_node_id,
    fallback_policy, channel_scope, nodes, published_by)
  SELECT t.account_id, t.id, 1, t.trigger_type, t.trigger_config, t.entry_node_id, t.fallback_policy,
    COALESCE(t.channel_scope, 'whatsapp'),
    COALESCE((SELECT jsonb_agg(jsonb_build_object('node_key', n.node_key, 'node_type', n.node_type,
        'config', n.config, 'position_x', n.position_x, 'position_y', n.position_y) ORDER BY n.node_key)
      FROM flow_nodes n WHERE n.account_id = t.account_id AND n.flow_id = t.id), '[]'::jsonb),
    NULL
  FROM targets t
  -- A straggler that already has a v1 (an interrupted manual re-run) is left alone.
  ON CONFLICT (account_id, flow_id, version) DO NOTHING
  RETURNING account_id, flow_id, id
)
UPDATE flows f SET published_version_id = ins.id
FROM ins WHERE f.account_id = ins.account_id AND f.id = ins.flow_id;

UPDATE flow_runs r SET flow_version_id = f.published_version_id
FROM flows f
WHERE r.status = 'active' AND r.flow_version_id IS NULL
  AND f.account_id = r.account_id AND f.id = r.flow_id
  AND f.status IN ('active','paused') AND f.published_version_id IS NOT NULL
  -- Pin only runs whose current step exists in that version. On the
  -- post-deploy re-run a straggler may sit on a node an old instance added
  -- after version 1; pinning it would cancel it (current_node_removed). Runs
  -- that fail this guard stay NULL and finish on the live draft as before.
  AND EXISTS (
    SELECT 1 FROM flow_versions v, jsonb_array_elements(v.nodes) e
    WHERE v.account_id = f.account_id AND v.id = f.published_version_id
      AND e->>'node_key' = r.current_node_key);
