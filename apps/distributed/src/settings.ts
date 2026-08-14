import z from '@deepseek-ai/schemastery'
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from '@deepseek-ai/dsh-agent-loop'
import { Config as DeepSeekConfig } from '@deepseek-ai/dsh-llm-deepseek'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PoolClient } from 'pg'
import { config } from './config.ts'
import { one, pool, tx } from './db.ts'
import { saveTenantModelConfig, type TenantModelConfig } from './model-config.ts'

interface StoredSetting {
  section: Record<string, unknown>
  revision: string
}

interface SettingDefinition {
  schema: z
  base: Record<string, unknown>
  applies: 'live' | 'restart'
}

export interface SettingsPathOperation {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

const localeSchema = z.object({ preference: z.union(['zh', 'en']).required(false) })
const themeSchema = z.object({ preference: z.union(['light', 'dark', 'system']).default('system') })
const conversationSchema = z.object({ busyEnter: z.union(['queue', 'steer']).default('queue') })
const onboardingSchema = z.object({ welcomeNoticeVersion: z.string().required(false) })
const agentPresetSchema = z.object({ default: z.string().default('standard') })
const permissionSchema = z.object({
  defaultPreset: z.union(['read-only', 'workspace-write', 'danger-full-access']).default('danger-full-access'),
})
const agentLoopSchema = z.object({
  maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS),
})

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function merge(left: unknown, right: unknown): unknown {
  if (typeof left !== 'object' || left === null || Array.isArray(left)
    || typeof right !== 'object' || right === null || Array.isArray(right)) return clone(right)
  const output: Record<string, unknown> = clone(left as Record<string, unknown>)
  for (const [key, value] of Object.entries(right as Record<string, unknown>)) {
    output[key] = key in output ? merge(output[key], value) : clone(value)
  }
  return output
}

function deepSeekBase(model: TenantModelConfig): Record<string, unknown> {
  const modelId = model.mode === 'deepseek' ? model.defaultModel : config.defaultModel
  return {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: model.mode === 'deepseek' ? model.baseUrl ?? config.deepSeekBaseUrl : config.deepSeekBaseUrl,
    thinking: 'enabled',
    reasoningEffort: 'off',
    models: [{ id: modelId, name: modelId }],
  }
}

function piAiBase(model: TenantModelConfig): Record<string, unknown> {
  if (model.mode !== 'openai') return { providers: {} }
  return {
    providers: {
      [model.provider]: {
        apiKeyEnv: 'OPENAI_API_KEY',
        displayName: 'OpenAI-compatible Chat Completions',
        api: 'openai-completions',
        baseURL: model.baseUrl ?? config.openAiBaseUrl,
        models: [{ id: model.defaultModel, name: model.defaultModel }],
      },
    },
  }
}

function definitions(model: TenantModelConfig): Map<string, SettingDefinition> {
  return new Map([
    ['locale', { schema: localeSchema, base: {}, applies: 'live' }],
    ['ui-theme', { schema: themeSchema, base: { preference: 'system' }, applies: 'live' }],
    ['ui-conversation', { schema: conversationSchema, base: { busyEnter: 'queue' }, applies: 'live' }],
    ['ui-onboarding', { schema: onboardingSchema, base: {}, applies: 'live' }],
    ['agent-presets', { schema: agentPresetSchema, base: { default: 'standard' }, applies: 'live' }],
    ['permission', { schema: permissionSchema, base: { defaultPreset: 'danger-full-access' }, applies: 'live' }],
    ['agent-loop', {
      schema: agentLoopSchema,
      base: { maxParallelToolCalls: DEFAULT_MAX_PARALLEL_TOOL_CALLS },
      applies: 'live',
    }],
    ['llm-deepseek', { schema: DeepSeekConfig as z, base: deepSeekBase(model), applies: 'live' }],
    ['llm-pi-ai', { schema: PiAiConfig as z, base: piAiBase(model), applies: 'live' }],
  ])
}

function resolved(definition: SettingDefinition, section: Record<string, unknown>): unknown {
  return definition.schema(merge(definition.base, section))
}

function view(namespace: string, definition: SettingDefinition, stored?: StoredSetting): Record<string, unknown> {
  const section = stored?.section ?? {}
  return {
    ns: namespace,
    schema: definition.schema.toJSON(),
    value: resolved(definition, section),
    base: clone(definition.base),
    ...(Object.keys(section).length === 0 ? {} : { user: clone(section) }),
    applies: definition.applies,
    secrets: [],
    revision: Number(stored?.revision ?? 0),
  }
}

export async function describeSettings(tenantId: string, model: TenantModelConfig): Promise<Record<string, unknown>[]> {
  const result = await pool.query<{ namespace: string; section: Record<string, unknown>; revision: string }>(
    'SELECT namespace, section, revision::text FROM tenant_settings WHERE tenant_id = $1',
    [tenantId],
  )
  const stored = new Map(result.rows.map(row => [row.namespace, { section: row.section, revision: row.revision }]))
  return [...definitions(model)].map(([namespace, definition]) => view(namespace, definition, stored.get(namespace)))
}

function assertPath(path: unknown): string[] {
  if (!Array.isArray(path) || path.some(segment => typeof segment !== 'string' || segment.length === 0)) {
    throw new TypeError('settings path must contain non-empty string segments')
  }
  return path as string[]
}

function mutateSection(section: Record<string, unknown>, operations: readonly SettingsPathOperation[]): Record<string, unknown> {
  const output = clone(section)
  for (const operation of operations) {
    const path = assertPath(operation.path)
    if (path.length === 0) {
      if (operation.op === 'unset') return {}
      return record(operation.value)
    }
    let parent = output
    for (const segment of path.slice(0, -1)) {
      const child = record(parent[segment])
      parent[segment] = child
      parent = child
    }
    const leaf = path[path.length - 1] as string
    if (operation.op === 'unset') Reflect.deleteProperty(parent, leaf)
    else parent[leaf] = clone(operation.value)
  }
  return output
}

async function storeSetting(
  client: PoolClient,
  tenantId: string,
  userId: string,
  namespace: string,
  definition: SettingDefinition,
  section: Record<string, unknown>,
  currentRevision: number,
): Promise<StoredSetting> {
  resolved(definition, section)
  const result = await client.query<{ section: Record<string, unknown>; revision: string }>(`
    INSERT INTO tenant_settings (tenant_id, namespace, section, revision, updated_by)
    VALUES ($1, $2, $3::jsonb, $4, $5)
    ON CONFLICT (tenant_id, namespace) DO UPDATE SET
      section = EXCLUDED.section, revision = EXCLUDED.revision,
      updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING section, revision::text
  `, [tenantId, namespace, JSON.stringify(section), currentRevision + 1, userId])
  return result.rows[0] as StoredSetting
}

export async function writeSetting(
  tenantId: string,
  userId: string,
  model: TenantModelConfig,
  namespace: string,
  write: { kind: 'update'; patch: Record<string, unknown> } | { kind: 'replace'; section: Record<string, unknown> }
    | { kind: 'mutate'; operations: SettingsPathOperation[] },
  expectedRevision?: number,
): Promise<Record<string, unknown>> {
  const definition = definitions(model).get(namespace)
  if (definition === undefined) throw new TypeError(`unknown settings namespace "${namespace}"`)
  const stored = await tx(async (client) => {
    const current = await client.query<StoredSetting>(
      'SELECT section, revision::text FROM tenant_settings WHERE tenant_id = $1 AND namespace = $2 FOR UPDATE',
      [tenantId, namespace],
    )
    const previous = current.rows[0]
    const revision = Number(previous?.revision ?? 0)
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      throw new Error(`settings namespace "${namespace}" changed since it was read`)
    }
    const before = previous?.section ?? {}
    const section = write.kind === 'update'
      ? record(merge(before, write.patch))
      : write.kind === 'replace'
        ? clone(write.section)
        : mutateSection(before, write.operations)
    return storeSetting(client, tenantId, userId, namespace, definition, section, revision)
  })
  return view(namespace, definition, stored)
}

function firstModel(value: unknown, fallback: string): string {
  const models = record(value)['models']
  if (!Array.isArray(models)) return fallback
  for (const candidate of models) {
    const id = record(candidate)['id']
    if (typeof id === 'string' && id.trim() !== '') return id.trim()
  }
  return fallback
}

/** Keep the existing distributed worker route in lockstep with the upstream Models settings UI. */
export async function synchronizeModelSetting(
  tenantId: string,
  userId: string,
  previous: TenantModelConfig,
  namespace: string,
): Promise<TenantModelConfig> {
  const value = record(await settingValue(tenantId, previous, namespace))
  if (namespace === 'llm-deepseek') {
    return saveTenantModelConfig(tenantId, userId, {
      mode: 'deepseek',
      defaultModel: firstModel(value, previous.mode === 'deepseek' ? previous.defaultModel : 'deepseek-chat'),
      baseUrl: typeof value['baseURL'] === 'string' && value['baseURL'].trim() !== ''
        ? value['baseURL'].trim()
        : config.deepSeekBaseUrl,
      clearApiKey: false,
    })
  }
  if (namespace !== 'llm-pi-ai') return previous
  const providers = record(value['providers'])
  const selected = record(providers[previous.provider] ?? Object.values(providers)[0])
  if (Object.keys(selected).length === 0) return previous
  return saveTenantModelConfig(tenantId, userId, {
    mode: 'openai',
    defaultModel: firstModel(selected, previous.mode === 'openai' ? previous.defaultModel : 'gpt-4.1'),
    baseUrl: typeof selected['baseURL'] === 'string' && selected['baseURL'].trim() !== ''
      ? selected['baseURL'].trim()
      : config.openAiBaseUrl,
    clearApiKey: false,
  })
}

export async function settingValue(tenantId: string, model: TenantModelConfig, namespace: string): Promise<unknown> {
  const definition = definitions(model).get(namespace)
  if (definition === undefined) return undefined
  const stored = await one<StoredSetting>(
    'SELECT section, revision::text FROM tenant_settings WHERE tenant_id = $1 AND namespace = $2',
    [tenantId, namespace],
  )
  return resolved(definition, stored?.section ?? {})
}
