/**
 * Upstream Cordis extensions mounted in each distributed command runtime.
 *
 * This adapter keeps tenant/workspace routing in the distributed app while
 * preserving the upstream plugins' registration and disposal behavior.
 *
 * @module @deepseek-ai/dsh-distributed/worker-extensions
 */

import type { Context } from '@deepseek-ai/cordis'
import * as RepeatToolReminder from '@deepseek-ai/dsh-repeat-tool-reminder'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as WorkspaceTools from './workspace-client.ts'

/** Stable Cordis plugin name used by diagnostics. */
export const name = 'distributed-worker-extensions'

/** Tenant and workspace selected for one command runtime. */
export interface Config {
  /** Tenant that owns the executing command. */
  tenantId: string
  /** Workspace selected by the session. */
  workspaceId: string
  /** Session permission preset enforced by the workspace execution service. */
  permissionPreset: string
}

/**
 * Mount upstream runtime plugins that are safe in the per-command Worker.
 * Workspace tools remain RPC-backed, while todo state and repeat reminders
 * use the owning Agent and durable session log in this process.
 *
 * @param ctx - Worker command context.
 * @param config - selected tenant and workspace identity.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(WorkspaceTools, config)
  await ctx.plugin(RepeatToolReminder, {})
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
}
