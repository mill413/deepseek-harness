/**
 * Upstream Web-agent composition hosted inside the shared Workspace process.
 *
 * The distributed deployment changes capability ownership, not the model-facing
 * catalog. This module boots the same base, Web, and shipped preset files as
 * `dsh --profile web`, while replacing filesystem-global and transport-global
 * owners with workspace/tenant-scoped adapters.
 *
 * @module @deepseek-ai/dsh-distributed/upstream-runtime
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CLI_CONFIG_ROOT = join(REPO_ROOT, 'apps/cli/config')
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')
const BASE_PATCH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const WEB_PATCH = join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml')
const POSTGRES_PERSISTENCE = fileURLToPath(new URL('./postgres-persistence.ts', import.meta.url))

/** Configuration whose values are safe to pin for one tenant/workspace host. */
export interface UpstreamRuntimeConfig {
  /** Tenant whose PostgreSQL rows this runtime may inspect or append. */
  tenantId: string
  /** Workspace whose session lineage this runtime owns. */
  workspaceId: string
  /** Canonical workspace directory exposed as the session cwd. */
  root: string
  /** Private runtime state directory inside the owning workspace volume. */
  stateRoot: string
  /** Tenant-authored preset mirror consumed as an ordinary trusted user root. */
  userPresetRoot: string
  /** Optional DeepSeek key used by the upstream Web-search provider. */
  deepSeekApiKey?: string
  /** Optional Anthropic-compatible DeepSeek search endpoint. */
  deepSeekSearchBaseUrl?: string
  /** Persistence owner; JSONL exists only for isolated composition tests. */
  persistence?: 'postgres' | 'jsonl'
}

/** Rows that belong to the standalone upstream browser transport, not this execution host. */
const DISTRIBUTED_TRANSPORT_ROWS = [
  'api-gateway',
  'client-hmr',
  'connection',
  'directory-picker',
  'modules',
  'plugin-inventory',
  'web-runtime',
  'web-startup',
  'webserver',
] as const

/**
 * Boot the official Web host and four official agent presets for one workspace.
 * PostgreSQL persistence and tenant model adapters are deliberately attached by
 * the caller after boot, so neither local JSONL nor process-global credentials
 * can become an accidental second source of truth.
 */
export async function bootUpstreamRuntime(config: UpstreamRuntimeConfig): Promise<Context> {
  const profileHome = join(config.stateRoot, 'profile')
  const profileDir = join(profileHome, 'profiles', 'distributed')
  const settingsPath = join(config.stateRoot, 'settings.yaml')
  const storageRoot = join(config.stateRoot, 'storages')
  const rootConfig = join(profileDir, 'cordis.yml')
  const persistence = config.persistence ?? 'postgres'
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  await mkdir(storageRoot, { recursive: true, mode: 0o700 })
  await writeFile(settingsPath, '{}\n', { mode: 0o600 })
  await writeFile(rootConfig, '[]\n', { mode: 0o600 })
  healProfilesModuleFallback(INSTALL_ANCHOR, profileHome)

  const patches: PatchOptions[] = [
    ...loadOverlayPatches('dsh-distributed', BASE_PATCH),
    ...loadOverlayPatches('dsh-distributed', WEB_PATCH),
    { id: 'settings', config: { path: settingsPath, watch: false } },
    { id: 'storage-json', config: { root: storageRoot } },
    persistence === 'postgres'
      ? { id: 'session-persistence-jsonl', disabled: true }
      : { id: 'session-persistence-jsonl', config: { root: join(config.stateRoot, 'sessions') } },
    ...persistence === 'postgres'
      ? [{
        insert: [{
          id: 'session-persistence-postgres',
          name: POSTGRES_PERSISTENCE,
          config: { tenantId: config.tenantId, workspaceId: config.workspaceId },
        }],
      }]
      : [],
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'attachment-local', config: { dshHome: config.stateRoot } },
    {
      id: 'session-query-sqlite',
      config: { path: join(config.stateRoot, 'session-query.sqlite'), openAt: 'first-search' },
    },
    { id: 'fs-sandbox', config: { cwd: config.root } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: config.root } },
    { id: 'approval', config: { policy: 'never' } },
    // Tenant-aware adapters are registered after the Host has booted.
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-pi-ai', disabled: true },
    {
      id: 'web-search-deepseek',
      config: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        ...config.deepSeekApiKey === undefined ? {} : { apiKey: config.deepSeekApiKey },
        ...config.deepSeekSearchBaseUrl === undefined ? {} : { baseURL: config.deepSeekSearchBaseUrl },
      },
    },
    ...DISTRIBUTED_TRANSPORT_ROWS.map(id => ({ id, disabled: true })),
    {
      id: 'agent-presets',
      config: {
        default: 'standard',
        roots: [
          { path: join(CLI_CONFIG_ROOT, 'agent-presets'), trust: 'system' },
          { path: config.userPresetRoot, trust: 'user' },
        ],
        includeUserRoot: false,
      },
    },
  ]

  return boot('dsh-distributed', rootConfig, patches, (ctx) => {
    provideCmdline(ctx, { args: [], exit: () => {} })
  })
}
