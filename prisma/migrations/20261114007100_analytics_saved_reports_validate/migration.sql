-- Validates the constraints 20261114007000 added NOT VALID. Every existing
-- report_runs and report_schedules row already satisfies them (the kind lists
-- only grew, minute_local defaults to 0, and no row names a saved report yet).
SET LOCAL lock_timeout = '5s';

ALTER TABLE report_runs VALIDATE CONSTRAINT report_runs_kind_check;
ALTER TABLE report_schedules VALIDATE CONSTRAINT report_schedules_kind_check;
ALTER TABLE report_schedules VALIDATE CONSTRAINT report_schedules_minute_local_check;
ALTER TABLE report_schedules VALIDATE CONSTRAINT report_schedules_saved_report_check;
ALTER TABLE report_schedules VALIDATE CONSTRAINT report_schedules_saved_report_fkey;
