-- Stage 5 (5A): validate every check and foreign key the Stage 5 migrations
-- added NOT VALID on existing tables. VALIDATE CONSTRAINT holds SHARE UPDATE
-- EXCLUSIVE, so reads and writes continue during each scan. Every existing row
-- holds the constant defaults ('[]', '{}', 'rules', 'all') or NULL, which pass;
-- every existing flow step type is in the widened list. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE flows VALIDATE CONSTRAINT flows_extra_triggers_check;
ALTER TABLE flows VALIDATE CONSTRAINT flows_test_usernames_check;
ALTER TABLE flows VALIDATE CONSTRAINT flows_canvas_notes_check;
ALTER TABLE flow_versions VALIDATE CONSTRAINT flow_versions_extra_triggers_check;
ALTER TABLE flows VALIDATE CONSTRAINT flows_folder_fkey;
ALTER TABLE workspace_inbox_settings VALIDATE CONSTRAINT workspace_inbox_settings_agent_reply_pause_check;
ALTER TABLE workspace_inbox_settings VALIDATE CONSTRAINT workspace_inbox_settings_auto_assign_mode_check;
ALTER TABLE workspace_inbox_settings VALIDATE CONSTRAINT workspace_inbox_settings_agent_visibility_check;
ALTER TABLE account_memberships VALIDATE CONSTRAINT account_memberships_max_open_conversations_check;
ALTER TABLE ai_workspace_settings VALIDATE CONSTRAINT ai_workspace_settings_instagram_goals_check;
ALTER TABLE flow_nodes VALIDATE CONSTRAINT flow_nodes_node_type_check;
