import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { config } from './config.ts'

/** Stable Cordis plugin name used by diagnostics. */
export const name = 'distributed-workspace-tools'

/** Services consumed by the remote tool adapter. */
export const inject = ['systemPrompt', 'tools']

/** Tenant and workspace selected for one command runtime. */
export interface Config {
  /** Tenant that owns the workspace. */
  tenantId: string
  /** Workspace whose catalog and executions are exposed. */
  workspaceId: string
}

interface WorkspaceCatalog {
  root: string
  tools: ToolSchema[]
  guidance: Array<{ name: string; order: number; text: string }>
}

interface RemoteEnvelope {
  content: ContentBlock[]
  meta?: unknown
  value: unknown
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function responseJson(response: Response): Promise<unknown> {
  const value = await response.json() as unknown
  if (!response.ok) {
    const message = record(record(value)?.['error'])?.['message']
    throw new Error(typeof message === 'string' ? message : `workspace service returned HTTP ${response.status}`)
  }
  return value
}

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(new URL(path, config.workspaceServiceUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.workspaceServiceToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    ...signal === undefined ? {} : { signal },
  })
  return responseJson(response)
}

function parseCatalog(value: unknown): WorkspaceCatalog {
  const body = record(value)
  if (body === undefined || typeof body['root'] !== 'string' || !Array.isArray(body['tools']) || !Array.isArray(body['guidance'])) {
    throw new Error('workspace service returned an invalid tool catalog')
  }
  return body as unknown as WorkspaceCatalog
}

function parseExecutionResult(value: unknown): ToolExecutionResult {
  const body = record(value)
  if (body === undefined || typeof body['isError'] !== 'boolean' || !Array.isArray(body['content'])) {
    throw new Error('workspace service returned an invalid tool result')
  }
  return body as unknown as ToolExecutionResult
}

/**
 * Register one workspace's upstream catalog as RPC-backed definitions.
 * Cordis owns the listener and tool registrations, so disposing this plugin
 * removes the complete remote generation from the command runtime.
 *
 * @param ctx - Worker command context carrying prompt and tool services.
 * @param pluginConfig - selected tenant and workspace identity.
 */
export async function apply(ctx: Context, pluginConfig: Config): Promise<void> {
  const { tenantId, workspaceId } = pluginConfig
  const catalog = parseCatalog(await post('/internal/v1/catalog', { tenantId, workspaceId }))
  const remoteNames = new Set(catalog.tools.map(tool => tool.name))
  for (const section of catalog.guidance) {
    ctx.systemPrompt.section({ name: section.name, order: section.order, text: section.text })
  }
  ctx.on('tools/execute', async (exec, next) => {
    if (!remoteNames.has(exec.name)) return next()
    const result = parseExecutionResult(await post('/internal/v1/tools/execute', {
      tenantId,
      workspaceId,
      callId: exec.callId,
      name: exec.name,
      arguments: exec.arguments,
    }, exec.signal))
    if (result.isError) return result
    return {
      ...result,
      value: {
        value: result.value,
        content: result.content,
        ...result.meta === undefined ? {} : { meta: result.meta },
      } as never,
    }
  })
  for (const schema of catalog.tools) {
    const definition: ToolDefinition = {
      ...schema,
      output: {
        schema: {},
        render: (_args, value) => (value as unknown as RemoteEnvelope).content,
        presentationMeta: (_args, value) => {
          const meta = (value as unknown as RemoteEnvelope).meta
          return meta === undefined ? {} : meta as never
        },
      },
      execute() {
        throw new Error(`workspace proxy invariant violated: ${schema.name} bypassed the remote execution wrapper`)
      },
    }
    ctx.tools.register(definition)
  }
}
