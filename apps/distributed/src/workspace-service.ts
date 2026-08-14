import { timingSafeEqual } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as ToolCallTimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import * as ToolStrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { config } from './config.ts'
import { HttpError, assertUuid } from './identity.ts'
import { workspaceRootPath } from './workspace-path.ts'

const BODY_LIMIT = 2 * 1024 * 1024
const PATH_TOOLS = new Map<string, string>([
  ['read', 'file_path'],
  ['write', 'file_path'],
  ['edit', 'file_path'],
  ['glob', 'path'],
  ['grep', 'path'],
  ['str_replace_editor', 'path'],
])

interface WorkspaceContext {
  ctx: Context
  root: string
}

interface ToolRequest {
  tenantId: string
  workspaceId: string
  callId: string
  name: string
  arguments: unknown
}

const contexts = new Map<string, Promise<WorkspaceContext>>()

function json(response: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  })
  response.end(data)
}

function authorized(request: IncomingMessage): boolean {
  const expected = Buffer.from(`Bearer ${config.workspaceServiceToken}`)
  const supplied = Buffer.from(request.headers.authorization ?? '')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<unknown>) {
    const buffer = typeof chunk === 'string'
      ? Buffer.from(chunk)
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : undefined
    if (buffer === undefined) throw new HttpError(400, 'request body contains an invalid chunk')
    size += buffer.length
    if (size > BODY_LIMIT) throw new HttpError(413, 'request body is too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'request body must be valid JSON')
  }
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'request body must be an object')
  }
  return value as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `${key} must be a non-empty string`)
  return value
}

function parseToolRequest(value: unknown): ToolRequest {
  const body = requestRecord(value)
  return {
    tenantId: assertUuid(requiredString(body, 'tenantId'), 'tenantId'),
    workspaceId: assertUuid(requiredString(body, 'workspaceId'), 'workspaceId'),
    callId: requiredString(body, 'callId'),
    name: requiredString(body, 'name'),
    arguments: body['arguments'],
  }
}

function isContained(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** Resolve the deepest existing ancestor so a symlink cannot redirect a file tool outside its workspace. */
async function containedPath(root: string, supplied: string): Promise<string> {
  const target = resolve(root, supplied)
  if (!isContained(root, target)) throw new HttpError(400, 'tool path must stay inside the selected workspace')
  const missing: string[] = []
  let existing = target
  while (true) {
    try {
      const canonical = resolve(await realpath(existing), ...missing)
      if (!isContained(root, canonical)) throw new HttpError(400, 'tool path resolves outside the selected workspace')
      return target
    } catch (error) {
      if (error instanceof HttpError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      missing.unshift(basename(existing))
      existing = parent
    }
  }
}

async function normalizedArguments(root: string, name: string, value: unknown): Promise<unknown> {
  const source = requestRecord(value)
  const args = { ...source }
  const pathField = PATH_TOOLS.get(name)
  if (pathField !== undefined) {
    const supplied = args[pathField]
    if (supplied === undefined && (name === 'glob' || name === 'grep')) {
      args[pathField] = root
    } else if (typeof supplied === 'string' && supplied.length > 0) {
      args[pathField] = await containedPath(root, supplied)
    } else {
      throw new HttpError(400, `${pathField} must be a non-empty string`)
    }
  }
  if (name === 'bash') {
    const workdir = args['workdir']
    if (workdir !== undefined && (typeof workdir !== 'string' || workdir.length === 0)) {
      throw new HttpError(400, 'workdir must be a non-empty string')
    }
    args['workdir'] = await containedPath(root, typeof workdir === 'string' ? workdir : root)
  }
  return args
}

async function createWorkspaceContext(tenantId: string, workspaceId: string): Promise<WorkspaceContext> {
  const requestedRoot = workspaceRootPath(tenantId, workspaceId)
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
  const root = await realpath(requestedRoot)
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(ToolCallTimeoutPolicy)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(LocalBashExecutor, { cwd: root })
    await ctx.plugin(ShellEnvRegistry, {})
    await ctx.plugin(LocalJobRegistry, {})
    await ctx.plugin(ToolFs, {})
    await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: false })
    await ctx.plugin(ToolStrReplaceEditor, {})
    await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
    await ctx.plugin(ToolBash, { enableRunInBackground: true })
    return { ctx, root }
  } catch (error) {
    await ctx.fiber.dispose().catch((disposeError: unknown) => {
      console.error('failed workspace context cleanup', disposeError)
    })
    throw error
  }
}

function workspaceContext(tenantId: string, workspaceId: string): Promise<WorkspaceContext> {
  const key = `${tenantId}/${workspaceId}`
  let pending = contexts.get(key)
  if (pending === undefined) {
    pending = createWorkspaceContext(tenantId, workspaceId)
    contexts.set(key, pending)
    void pending.catch(() => { contexts.delete(key) })
  }
  return pending
}

async function catalog(tenantId: string, workspaceId: string): Promise<unknown> {
  const { ctx, root } = await workspaceContext(tenantId, workspaceId)
  const assembly = await ctx.systemPrompt.assemble()
  return {
    root,
    tools: ctx.tools.schemas(),
    guidance: assembly.sections
      .filter(section => section.name.startsWith('tool:'))
      .map(section => ({ name: section.name, order: assembly.sections.indexOf(section) + 100, text: section.text })),
  }
}

async function executeTool(tool: ToolRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
  const workspace = await workspaceContext(tool.tenantId, tool.workspaceId)
  const args = await normalizedArguments(workspace.root, tool.name, tool.arguments)
  return workspace.ctx.tools.execute({
    callId: tool.callId as never,
    name: tool.name,
    arguments: args,
    signal,
  })
}

const server = createServer((request, response) => {
  void (async () => {
    if (request.method === 'GET' && request.url === '/healthz') {
      json(response, 200, { ok: true, service: 'workspace', contexts: contexts.size })
      return
    }
    if (!authorized(request)) throw new HttpError(401, 'unauthorized')
    if (request.method === 'POST' && request.url === '/internal/v1/catalog') {
      const body = requestRecord(await readJson(request))
      json(response, 200, await catalog(
        assertUuid(requiredString(body, 'tenantId'), 'tenantId'),
        assertUuid(requiredString(body, 'workspaceId'), 'workspaceId'),
      ))
      return
    }
    if (request.method === 'POST' && request.url === '/internal/v1/tools/execute') {
      const controller = new AbortController()
      request.once('aborted', () => {
        controller.abort(new Error('workspace tool client disconnected'))
      })
      response.once('close', () => {
        if (!response.writableEnded) controller.abort(new Error('workspace tool client disconnected'))
      })
      json(response, 200, await executeTool(parseToolRequest(await readJson(request)), controller.signal))
      return
    }
    throw new HttpError(404, 'not found')
  })().catch((error: unknown) => {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const status = error instanceof HttpError ? error.status : 500
    if (status === 500) console.error('workspace request failed', error)
    json(response, status, { error: { message: error instanceof Error ? error.message : String(error) } })
  })
})

server.listen(config.workspacePort, '0.0.0.0', () => {
  console.log(`workspace service listening on ${config.workspacePort} with root ${config.workspaceRoot}`)
})

async function shutdown(): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => { if (error === undefined) resolveClose(); else rejectClose(error) })
  })
  const settled = await Promise.allSettled([...contexts.values()].map(async (pending) => {
    const { ctx } = await pending
    await ctx.fiber.dispose()
  }))
  const failures: unknown[] = []
  for (const result of settled) {
    if (result.status === 'rejected') failures.push(result.reason as unknown)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'workspace shutdown failed')
}

function handleShutdown(): void {
  void shutdown().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}

process.once('SIGTERM', handleShutdown)
process.once('SIGINT', handleShutdown)
