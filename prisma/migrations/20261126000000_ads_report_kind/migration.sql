-- Ads phases: the "Ads summary" report kind (one row per Meta campaign: spend,
-- delivery, chats and attributed revenue), so it can be requested and
-- scheduled like the other reports (a weekly ads email is a weekly schedule).
SET LOCAL lock_timeout = '5s';

ALTER TABLE report_runs DROP CONSTRAINT report_runs_kind_check; -- additive-exception: widened below to also allow 'ads_summary'
ALTER TABLE report_runs ADD CONSTRAINT report_runs_kind_check
  CHECK (kind IN ('campaign_daily','campaign_summary','member_campaigns','agent_performance',
    'product_summary','service_summary','commerce_daily','saved_report','ads_summary')) NOT VALID;
ALTER TABLE report_runs VALIDATE CONSTRAINT report_runs_kind_check;

ALTER TABLE report_schedules DROP CONSTRAINT report_schedules_kind_check; -- additive-exception: widened below to also allow 'ads_summary'
ALTER TABLE report_schedules ADD CONSTRAINT report_schedules_kind_check
  CHECK (kind IN ('campaign_daily','campaign_summary','member_campaigns','agent_performance',
    'product_summary','service_summary','commerce_daily','saved_report','ads_summary')) NOT VALID;
ALTER TABLE report_schedules VALIDATE CONSTRAINT report_schedules_kind_check;
