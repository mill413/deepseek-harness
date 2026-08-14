import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
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
  /** Permission preset pinned on the owning session. */
  permissionPreset: string
}

export interface WorkspaceSkill {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  content: string
  directory: string
}

export interface WorkspaceCatalog {
  root: string
  tools: ToolSchema[]
  skills: WorkspaceSkill[]
  guidance: Array<{ name: string; order: number; text: string }>
}

interface RemoteEnvelope {
  content: ContentBlock[]
  meta?: unknown
  value: unknown
}

/** Complete command envelope delegated by a queue Worker to the execution host. */
export interface WorkspaceAgentCommand {
  tenantId: string
  workspaceId: string
  sessionId: string
  provider: string
  model: string
  agentPreset: string
  permissionPreset: string
  payload: { text?: string; action?: 'compact' }
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

/** Execute one queued Agent command in the long-lived shared execution host. */
export async function executeWorkspaceAgentCommand(command: WorkspaceAgentCommand, signal?: AbortSignal): Promise<string> {
  const value = record(await post('/internal/v1/agents/execute', command, signal))
  if (typeof value?.['finalText'] !== 'string') throw new Error('workspace service returned an invalid Agent result')
  return value['finalText']
}

/** Cancel the live root Agent for one tenant session, if it is owned by the host. */
export async function cancelWorkspaceAgent(tenantId: string, sessionId: string): Promise<void> {
  await post('/internal/v1/agents/cancel', { tenantId, sessionId })
}

/** Invoke one browser-facing dynamic Cordis method on its owning Workspace runtime. */
export async function workspaceDynamicCordisRpc(
  tenantId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return post('/internal/v1/dynamic-cordis', { tenantId, method, args })
}

/** Use the official subagent registry in the owning long-lived Workspace runtime. */
export async function workspaceSubagentRpc(
  tenantId: string,
  workspaceId: string,
  operation: 'list' | 'prompt' | 'interrupt',
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  return post('/internal/v1/subagents', { tenantId, workspaceId, operation, args }, signal)
}

/** Retire one tenant's cached model/search adapters after a settings or credential change. */
export async function invalidateWorkspaceTenant(tenantId: string): Promise<void> {
  await post('/internal/v1/runtime/invalidate', { tenantId })
}

/** Read the real upstream Cordis Loader inventory for one tenant workspace. */
export async function workspacePluginInventory(tenantId: string, workspaceId: string): Promise<unknown> {
  return post('/internal/v1/plugin-inventory', { tenantId, workspaceId })
}

function parseCatalog(value: unknown): WorkspaceCatalog {
  const body = record(value)
  if (body === undefined || typeof body['root'] !== 'string' || !Array.isArray(body['tools'])
    || !Array.isArray(body['skills']) || !Array.isArray(body['guidance'])) {
    throw new Error('workspace service returned an invalid tool catalog')
  }
  return body as unknown as WorkspaceCatalog
}

export async function workspaceCatalogFor(tenantId: string, workspaceId: string): Promise<WorkspaceCatalog> {
  return parseCatalog(await post('/internal/v1/catalog', { tenantId, workspaceId }))
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
  const { tenantId, workspaceId, permissionPreset } = pluginConfig
  const catalog = await workspaceCatalogFor(tenantId, workspaceId)
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
      permissionPreset,
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
  if (catalog.skills.length > 0) {
    ctx.systemPrompt.section({
      name: 'skills:catalog',
      order: 170,
      text: [
        '<available_skills>',
        ...catalog.skills.filter(skill => skill.modelInvocable)
          .map(skill => `- ${skill.name}: ${skill.description}`),
        '</available_skills>',
        'Call the skill tool with the exact name before following a matching skill.',
      ].join('\n'),
    })
  }
  ctx.tools.register(defineTool({
    name: 'skill',
    description: 'Load full instructions for an available workspace skill.',
    parameters: { name: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `<skill_content name="${value.name}">\n${value.content}\n</skill_content>` }],
    },
    execute(args) {
      const skill = catalog.skills.find(candidate => candidate.name === args.name && candidate.modelInvocable)
      if (skill === undefined) throw new Error(`skill "${args.name}" is unknown or unavailable to the model`)
      return Promise.resolve({ name: skill.name, content: skill.content })
    },
  }))
  ctx.on('agent/pre-step', async ({ messages }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const requested = new Set<string>()
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type !== 'text') continue
        const match = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/u.exec(block.text.trimStart())
        if (match?.[1] !== undefined) requested.add(match[1])
      }
    }
    const injections = catalog.skills
      .filter(skill => requested.has(skill.name))
      .map(skill => createUserMessage({
        content: [{ type: 'text', text: `<skill_content name="${skill.name}">\n${skill.content}\n</skill_content>` }],
        source: { kind: 'plugin', plugin: 'distributed-workspace-skills', form: 'instructions', summary: `Skill ${skill.name}` },
      }))
    return injections.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...injections] }
  })
}
