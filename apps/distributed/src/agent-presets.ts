import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { one, pool } from './db.ts'

const SYSTEM_PRESETS_ROOT = new URL('../../cli/config/agent-presets/', import.meta.url)
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

interface UserPresetRow {
  id: string
  name: string | null
  description: string | null
  content: string
}

export interface PresetEntry {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
  name?: string
  description?: string
}

function assertPresetId(value: unknown): string {
  if (typeof value !== 'string' || !PRESET_ID_PATTERN.test(value)) {
    throw new TypeError('agent preset id must contain lowercase letters, numbers, and hyphens')
  }
  return value
}

function metadata(content: string): { name?: string; description?: string } {
  const output: { name?: string; description?: string } = {}
  for (const line of content.split('\n')) {
    const match = /^(name|description):\s*(.+)$/u.exec(line)
    const value = match?.[2]?.trim()
    if (match?.[1] === 'name' && value !== undefined) output.name = value
    if (match?.[1] === 'description' && value !== undefined) output.description = value
  }
  return output
}

async function systemPreset(id: string): Promise<{ content: string; name?: string; description?: string } | undefined> {
  try {
    const [content, presetMetadata] = await Promise.all([
      readFile(new URL(`${id}/agent.cordis.yml`, SYSTEM_PRESETS_ROOT), 'utf8'),
      readFile(new URL(`${id}/preset.yml`, SYSTEM_PRESETS_ROOT), 'utf8'),
    ])
    return { content, ...metadata(presetMetadata) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function systemPresetIds(): Promise<string[]> {
  const entries = await readdir(SYSTEM_PRESETS_ROOT, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory() && PRESET_ID_PATTERN.test(entry.name)).map(entry => entry.name).sort()
}

export async function listAgentPresets(tenantId: string, defaultPreset: string): Promise<PresetEntry[]> {
  const system = await Promise.all((await systemPresetIds()).map(async (id): Promise<PresetEntry> => {
    const preset = await systemPreset(id)
    return {
      id,
      trust: 'system',
      isDefault: id === defaultPreset,
      ...(preset?.name === undefined ? {} : { name: preset.name }),
      ...(preset?.description === undefined ? {} : { description: preset.description }),
    }
  }))
  const result = await pool.query<UserPresetRow>(
    'SELECT id, name, description, content FROM tenant_agent_presets WHERE tenant_id = $1 ORDER BY id',
    [tenantId],
  )
  return [...system, ...result.rows
    .filter(row => !system.some(entry => entry.id === row.id))
    .map(row => ({
      id: row.id,
      trust: 'user' as const,
      isDefault: row.id === defaultPreset,
      ...(row.name === null ? {} : { name: row.name }),
      ...(row.description === null ? {} : { description: row.description }),
    }))]
}

export async function readAgentPreset(
  tenantId: string,
  presetValue: unknown,
): Promise<{ agentPreset: string; trust: 'system' | 'user'; content: string; name?: string; description?: string }> {
  const id = assertPresetId(presetValue)
  const system = await systemPreset(id)
  if (system !== undefined) return { agentPreset: id, trust: 'system', ...system }
  const user = await one<UserPresetRow>(
    'SELECT id, name, description, content FROM tenant_agent_presets WHERE tenant_id = $1 AND id = $2',
    [tenantId, id],
  )
  if (user === undefined) throw new Error(`agent preset "${id}" was not found`)
  return {
    agentPreset: id,
    trust: 'user',
    content: user.content,
    ...(user.name === null ? {} : { name: user.name }),
    ...(user.description === null ? {} : { description: user.description }),
  }
}

export async function copyAgentPreset(
  tenantId: string,
  userId: string,
  fromValue: unknown,
  targetValue: unknown,
  nameValue: unknown,
): Promise<string> {
  const source = await readAgentPreset(tenantId, fromValue)
  const target = assertPresetId(targetValue)
  if (await systemPreset(target) !== undefined) throw new Error(`agent preset "${target}" already exists`)
  const name = typeof nameValue === 'string' && nameValue.trim() !== '' ? nameValue.trim() : target
  await pool.query(`
    INSERT INTO tenant_agent_presets (tenant_id, id, name, description, content, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [tenantId, target, name, source.description ?? null, source.content, userId])
  return target
}

export async function removeAgentPreset(tenantId: string, presetValue: unknown): Promise<void> {
  const id = assertPresetId(presetValue)
  if (await systemPreset(id) !== undefined) throw new Error('shipped agent presets cannot be removed')
  const result = await pool.query('DELETE FROM tenant_agent_presets WHERE tenant_id = $1 AND id = $2', [tenantId, id])
  if (result.rowCount === 0) throw new Error(`agent preset "${id}" was not found`)
}

export async function hasAgentPreset(tenantId: string, presetValue: unknown): Promise<string> {
  const id = assertPresetId(presetValue)
  if (await systemPreset(id) !== undefined) return id
  const user = await one<{ id: string }>('SELECT id FROM tenant_agent_presets WHERE tenant_id = $1 AND id = $2', [tenantId, id])
  if (user === undefined) throw new Error(`agent preset "${id}" was not found`)
  return id
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    if (await readFile(path, 'utf8') === content) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await writeFile(path, content, { mode: 0o600 })
}

/** Materialize PostgreSQL-authored presets into the official filesystem roster consumed by the Workspace runtime. */
export async function materializeAgentPresets(tenantId: string, root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const result = await pool.query<UserPresetRow>(
    'SELECT id, name, description, content FROM tenant_agent_presets WHERE tenant_id = $1 ORDER BY id',
    [tenantId],
  )
  const expected = new Set(result.rows.map(row => row.id))
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && PRESET_ID_PATTERN.test(entry.name) && !expected.has(entry.name)) {
      await rm(resolve(root, entry.name), { recursive: true, force: true })
    }
  }
  for (const row of result.rows) {
    const directory = resolve(root, row.id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const presetMetadata = [
      `name: ${JSON.stringify(row.name ?? row.id)}`,
      `description: ${JSON.stringify(row.description ?? '')}`,
      '',
    ].join('\n')
    await Promise.all([
      writeIfChanged(resolve(directory, 'agent.cordis.yml'), row.content),
      writeIfChanged(resolve(directory, 'preset.yml'), presetMetadata),
    ])
  }
}
