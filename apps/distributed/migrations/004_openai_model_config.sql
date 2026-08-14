ALTER TABLE tenant_model_configs
  DROP CONSTRAINT IF EXISTS tenant_model_configs_mode_check;

ALTER TABLE tenant_model_configs
  ADD CONSTRAINT tenant_model_configs_mode_check
  CHECK (mode IN ('mock', 'deepseek', 'openai'));
