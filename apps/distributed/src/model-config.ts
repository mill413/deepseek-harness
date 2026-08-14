import { config } from './config.ts'
import { one, pool } from './db.ts'
import { decryptSecret, encryptSecret } from './secrets.ts'

export interface TenantModelConfig {
  mode: 'mock' | 'deepseek'
  provider: string
  defaultModel: string
  baseUrl: string | null
  apiKey: string | null
  apiKeyConfigured: boolean
}

interface ModelConfigRow {
  mode: 'mock' | 'deepseek'
  provider: string
  default_model: string
  base_url: string | null
  api_key_encrypted: string | null
}

function defaults(): TenantModelConfig {
  const mode = config.llmMode
  return {
    mode,
    provider: mode === 'deepseek' ? 'deepseek-official' : 'distributed-mock',
    defaultModel: config.defaultModel,
    baseUrl: mode === 'deepseek' ? config.deepSeekBaseUrl : null,
    apiKey: config.deepSeekApiKey || null,
    apiKeyConfigured: config.deepSeekApiKey !== '',
  }
}

export async function tenantModelConfig(tenantId: string): Promise<TenantModelConfig> {
  const row = await one<ModelConfigRow>(
    'SELECT mode, provider, default_model, base_url, api_key_encrypted FROM tenant_model_configs WHERE tenant_id = $1',
    [tenantId],
  )
  if (row === undefined) return defaults()
  const storedKey = row.api_key_encrypted === null ? null : decryptSecret(row.api_key_encrypted)
  const fallbackKey = config.deepSeekApiKey || null
  return {
    mode: row.mode,
    provider: row.provider,
    defaultModel: row.default_model,
    baseUrl: row.base_url,
    apiKey: storedKey ?? fallbackKey,
    apiKeyConfigured: storedKey !== null || fallbackKey !== null,
  }
}

export interface ModelConfigUpdate {
  mode: 'mock' | 'deepseek'
  defaultModel: string
  baseUrl: string | null
  apiKey?: string
  clearApiKey: boolean
}

export async function saveTenantModelConfig(tenantId: string, userId: string, update: ModelConfigUpdate): Promise<TenantModelConfig> {
  const existing = await one<{ api_key_encrypted: string | null }>(
    'SELECT api_key_encrypted FROM tenant_model_configs WHERE tenant_id = $1',
    [tenantId],
  )
  const apiKeyEncrypted = update.clearApiKey
    ? null
    : update.apiKey === undefined
      ? existing?.api_key_encrypted ?? null
      : encryptSecret(update.apiKey)
  const provider = update.mode === 'deepseek' ? 'deepseek-official' : 'distributed-mock'
  await pool.query(`
    INSERT INTO tenant_model_configs
      (tenant_id, mode, provider, default_model, base_url, api_key_encrypted, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (tenant_id) DO UPDATE SET
      mode = EXCLUDED.mode, provider = EXCLUDED.provider, default_model = EXCLUDED.default_model,
      base_url = EXCLUDED.base_url, api_key_encrypted = EXCLUDED.api_key_encrypted,
      updated_by = EXCLUDED.updated_by, updated_at = now()
  `, [tenantId, update.mode, provider, update.defaultModel, update.baseUrl, apiKeyEncrypted, userId])
  return tenantModelConfig(tenantId)
}

export function publicModelConfig(value: TenantModelConfig): Omit<TenantModelConfig, 'apiKey'> {
  const { apiKey: _apiKey, ...visible } = value
  return visible
}
