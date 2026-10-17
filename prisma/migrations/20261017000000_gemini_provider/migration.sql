ALTER TABLE ai_configs DROP CONSTRAINT ai_configs_provider_check;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openai_compatible', 'gemini'));

ALTER TABLE ai_configs ALTER COLUMN api_key DROP NOT NULL;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_api_key_required_check
  CHECK (provider = 'gemini' OR api_key IS NOT NULL);

ALTER TABLE ai_usage_log DROP CONSTRAINT ai_usage_log_provider_check;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openai_compatible', 'gemini'));
