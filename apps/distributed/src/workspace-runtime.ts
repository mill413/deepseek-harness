/**
 * Cordis composition hosted by the shared Workspace process.
 *
 * Upstream filesystem and process plugins run unchanged in the volume-owning
 * process. The distributed service only supplies a workspace-specific root and
 * exposes their schemas and executions over its internal HTTP protocol.
 *
 * @module @deepseek-ai/dsh-distributed/workspace-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
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
import ToolRuntime from '@deepseek-ai/dsh-tools'

/** Stable Cordis plugin name used by diagnostics. */
export const name = 'distributed-workspace-runtime'

/** Workspace-scoped composition configuration. */
export interface Config {
  /** Canonical directory owned by this workspace context. */
  root: string
}

/**
 * Mount the upstream local providers and model-facing tools for one workspace.
 * Child plugins inherit this plugin's lifecycle and are recursively disposed
 * when the workspace context is evicted or the service shuts down.
 *
 * @param ctx - workspace Cordis context.
 * @param config - canonical workspace root.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(ToolCallTimeoutPolicy)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: config.root })
  await ctx.plugin(LocalBashExecutor, { cwd: config.root })
  await ctx.plugin(ShellEnvRegistry, {})
  await ctx.plugin(LocalJobRegistry, {})
  await ctx.plugin(ToolFs, {})
  await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: false })
  await ctx.plugin(ToolStrReplaceEditor, {})
  await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  await ctx.plugin(ToolBash, { enableRunInBackground: true })
}
