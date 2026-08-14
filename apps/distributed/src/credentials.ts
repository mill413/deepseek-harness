import { one, pool } from './db.ts'
import type { TenantModelConfig } from './model-config.ts'
import { saveTenantModelConfig } from './model-config.ts'
import { decryptSecret, encryptSecret } from './secrets.ts'

interface CredentialRow {
  value_encrypted: string
}

const REFERENCE_PATTERN = /^[A-Z][A-Z0-9_]*$/u

function assertReference(reference: unknown): string {
  if (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference)) {
    throw new TypeError('credential reference must be an uppercase environment-style name')
  }
  return reference
}

function modelReference(model: TenantModelConfig): string | undefined {
  if (model.mode === 'deepseek') return 'DEEPSEEK_API_KEY'
  if (model.mode === 'openai') return 'OPENAI_API_KEY'
  return undefined
}

export async function describeCredentials(
  tenantId: string,
  model: TenantModelConfig,
  references: unknown[],
): Promise<Record<string, { configured: boolean; source?: string; writable: boolean }>> {
  const unique = [...new Set(references.map(assertReference))]
  if (unique.length === 0) return {}
  const result = await pool.query<{ reference: string }>(
    'SELECT reference FROM tenant_credentials WHERE tenant_id = $1 AND reference = ANY($2::text[])',
    [tenantId, unique],
  )
  const stored = new Set(result.rows.map(row => row.reference))
  const fallback = modelReference(model)
  return Object.fromEntries(unique.map((reference) => {
    const configured = stored.has(reference) || (reference === fallback && model.apiKeyConfigured)
    return [reference, {
      configured,
      ...(configured ? { source: stored.has(reference) ? 'tenant' : 'model-config' } : {}),
      writable: true,
    }]
  }))
}

export async function resolveCredential(tenantId: string, reference: string): Promise<string | undefined> {
  const row = await one<CredentialRow>(
    'SELECT value_encrypted FROM tenant_credentials WHERE tenant_id = $1 AND reference = $2',
    [tenantId, assertReference(reference)],
  )
  return row === undefined ? undefined : decryptSecret(row.value_encrypted)
}

export async function setCredential(
  tenantId: string,
  userId: string,
  model: TenantModelConfig,
  referenceValue: unknown,
  value: unknown,
): Promise<void> {
  const reference = assertReference(referenceValue)
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('credential value must be non-empty')
  await pool.query(`
    INSERT INTO tenant_credentials (tenant_id, reference, value_encrypted, updated_by)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, reference) DO UPDATE SET
      value_encrypted = EXCLUDED.value_encrypted, updated_by = EXCLUDED.updated_by, updated_at = now()
  `, [tenantId, reference, encryptSecret(value), userId])
  if (reference === modelReference(model)) {
    await saveTenantModelConfig(tenantId, userId, {
      mode: model.mode,
      defaultModel: model.defaultModel,
      baseUrl: model.baseUrl,
      apiKey: value,
      clearApiKey: false,
    })
  }
}

export async function unsetCredential(
  tenantId: string,
  userId: string,
  model: TenantModelConfig,
  referenceValue: unknown,
): Promise<void> {
  const reference = assertReference(referenceValue)
  await pool.query('DELETE FROM tenant_credentials WHERE tenant_id = $1 AND reference = $2', [tenantId, reference])
  if (reference === modelReference(model)) {
    await saveTenantModelConfig(tenantId, userId, {
      mode: model.mode,
      defaultModel: model.defaultModel,
      baseUrl: model.baseUrl,
      clearApiKey: true,
    })
  }
}
