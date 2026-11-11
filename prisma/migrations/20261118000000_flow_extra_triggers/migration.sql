-- Stage 5 (5A): more than one trigger per flow, test usernames and canvas notes.
--
--   flows.extra_triggers / flow_versions.extra_triggers
--       Further triggers that also start the flow ([{trigger_type, config}],
--       COMBINABLE_TRIGGERS only, Instagram flows only; the validator in
--       src/lib/flows/validate.ts holds those rules). At most 4, so a flow has at
--       most 5 triggers. Publishing snapshots them into flow_versions; matching
--       reads the snapshot. '[]' is every flow before Stage 5: the primary
--       trigger only, exactly as today.
--   flows.test_usernames
--       While an Instagram flow is a draft it runs only for these usernames
--       (lowercase, no @, up to 3), like the WhatsApp test_numbers.
--   flows.canvas_notes
--       Sticky notes on the canvas ([{id, text, x, y}], at most 30). Editor only:
--       never run and not versioned.
--
-- Additive: constant defaults (no table rewrite). The checks are NOT VALID here
-- and validated by 20261118001200_stage5_validate. flow_versions rows are
-- immutable (BEFORE UPDATE trigger); adding a column with a constant default
-- updates no row. The app role's INSERT on flow_versions is a column list, so it
-- gains extra_triggers for the publish path.
SET LOCAL lock_timeout = '5s';

ALTER TABLE flows ADD COLUMN extra_triggers jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE flows ADD COLUMN test_usernames text[] NOT NULL DEFAULT '{}';
ALTER TABLE flows ADD COLUMN canvas_notes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE flow_versions ADD COLUMN extra_triggers jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE flows ADD CONSTRAINT flows_extra_triggers_check
  CHECK (jsonb_typeof(extra_triggers) = 'array' AND jsonb_array_length(extra_triggers) <= 4
    AND octet_length(extra_triggers::text) <= 65536) NOT VALID;
-- Lowercase Instagram usernames without '@' (letters, digits, '.', '_', 1-30 each); '' is the empty list.
ALTER TABLE flows ADD CONSTRAINT flows_test_usernames_check
  CHECK (cardinality(test_usernames) <= 3
    AND array_to_string(test_usernames, ',') ~ '^([a-z0-9._]{1,30}(,|$))*$') NOT VALID;
ALTER TABLE flows ADD CONSTRAINT flows_canvas_notes_check
  CHECK (jsonb_typeof(canvas_notes) = 'array' AND jsonb_array_length(canvas_notes) <= 30
    AND octet_length(canvas_notes::text) <= 65536) NOT VALID;
ALTER TABLE flow_versions ADD CONSTRAINT flow_versions_extra_triggers_check
  CHECK (jsonb_typeof(extra_triggers) = 'array' AND jsonb_array_length(extra_triggers) <= 4) NOT VALID;

GRANT INSERT (extra_triggers) ON flow_versions TO bodhinox_app;
