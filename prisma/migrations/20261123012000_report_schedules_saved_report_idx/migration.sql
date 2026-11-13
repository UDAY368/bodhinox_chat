CREATE UNIQUE INDEX CONCURRENTLY report_schedules_saved_report_idx ON report_schedules (account_id, saved_report_id) WHERE saved_report_id IS NOT NULL;
