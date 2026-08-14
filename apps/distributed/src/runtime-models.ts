/** Tenant-scoped model routes shared by the distributed execution host. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import {
  CallId,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { config } from './config.ts'
import type { TenantModelConfig } from './model-config.ts'
import * as OpenAiCompatible from './openai-compatible.ts'

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }, { once: true })
  })
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolChunks(callId: string, name: string, input: unknown): StreamChunk[] {
  const id = CallId(callId)
  const args = JSON.stringify(input)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Deterministic adapter used by distributed end-to-end tests. */
class DistributedMockAdapter extends LlmAdapter {
  private calls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 16_384 })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await delay(config.mockDelayMs, options.signal)
    if (options.purpose === 'compaction') {
      yield * textChunks('Earlier turns verified the distributed Web API, settings, permissions, goals, feedback, and shared workspace.')
      return
    }
    const last = options.messages.at(-1)
    const latestUser = options.messages.findLast(message => message.role === 'user' && message.source.kind === 'user')
    const hasToolResult = last?.content.some(block => block.type === 'tool-result') === true
    const requests = (marker: string): boolean => latestUser?.content.some(
      block => block.type === 'text' && block.text.includes(marker),
    ) === true
    const requestsWorkspaceProbe = requests('[workspace-e2e]')
    const requestsTodoProbe = requests('[todo-e2e]')
    const requestsQuestionProbe = requests('[question-e2e]')
    const requestsGoalProbe = requests('[goal-e2e]')
    const requestsSubagentProbe = requests('[subagent-e2e]')
    const requestsWorkflowProbe = requests('[workflow-e2e]')
    const requestsCodeProbe = requests('[code-e2e]')
    const requestsCatalogProbe = requests('[catalog-e2e]')
    const requestsCordisProbe = requests('[cordis-e2e]')
    const chunks = requestsCatalogProbe
      ? textChunks(`tool-catalog:${JSON.stringify((options.tools ?? []).map(tool => tool.name).sort())}`)
      : hasToolResult
        ? textChunks(`completed by ${config.workerId}`)
        : requestsWorkspaceProbe
          ? toolChunks(`${config.workerId}-${++this.calls}-${randomUUID()}`, 'bash', {
            command: 'printf workspace-proxy-ok > worker-proxy.txt && pwd && printf workspace-proxy-ok',
            description: 'Verify shared workspace execution',
          })
          : requestsTodoProbe
            ? toolChunks(`${config.workerId}-${++this.calls}-${randomUUID()}`, 'todo_write', {
              todos: [{ content: 'Verify upstream plugin adaptation', status: 'completed' }],
            })
            : requestsQuestionProbe
              ? toolChunks(`${config.workerId}-${++this.calls}-${randomUUID()}`, 'ask_user_question', {
                questions: [{
                  id: 'distributed-parity',
                  question: 'Continue the distributed parity test?',
                  header: 'Parity',
                  options: [{ label: 'Continue' }, { label: 'Cancel' }],
                }],
              })
              : requestsGoalProbe
                ? toolChunks(`${config.workerId}-${++this.calls}-${randomUUID()}`, 'create_goal', {
                  objective: 'Verify the distributed upstream goal tool',
                  max_goal_rounds: 2,
                })
                : requestsSubagentProbe
                  ? toolChunks(`${config.workerId}-${++this.calls}-${randomUUID()}`, 'subagent', {
                    description: 'Distributed child Agent parity probe',
                    prompt: 'Reply with exactly CHILD_OK.',
                    run_in_background: false,
                  })
                  : requestsWorkflowProbe
                    ? toolChunks(`${config.workerId}-${++this.calls}-${randomUUID()}`, 'workflow', {
                      meta: { name: 'distributed-parity', description: 'Verify the upstream workflow engine' },
                      script: "return await agent('Reply with exactly WORKFLOW_CHILD_OK.')",
                    })
                    : requestsCodeProbe
                      ? toolChunks(`${config.workerId}-${++this.calls}-${randomUUID()}`, 'run_code', {
                        code: "return await tools.bash({ command: 'printf code-mode-ok' })",
                        description: 'Verify upstream Code Mode execution',
                      })
                      : requestsCordisProbe
                        ? toolChunks(`${config.workerId}-${++this.calls}-${randomUUID()}`, 'cordis_define', {
                          plugin: { kind: 'new', idPrefix: 'parity' },
                          name: 'Distributed Cordis parity probe',
                          purpose: 'Verify that the distributed browser and Workspace share the official dynamic Cordis registry.',
                          code: { host: "return (ctx) => { ctx.effect(() => () => {}, 'distributed-cordis-parity') }" },
                        })
                        : textChunks(`completed by ${config.workerId}`)
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

/** Register exactly the tenant model route selected by the distributed settings plane. */
export async function registerRuntimeModels(ctx: Context, modelConfig: TenantModelConfig): Promise<void> {
  ctx.llm.registerAdapter(['distributed-mock'], new DistributedMockAdapter())
  if (modelConfig.mode === 'deepseek') {
    const options = resolveAdapterOptions({
      baseURL: modelConfig.baseUrl ?? config.deepSeekBaseUrl,
      models: [{ id: modelConfig.defaultModel, name: modelConfig.defaultModel }],
    })
    ctx.llm.registerAdapter(['deepseek-official'], new DeepSeekAdapter({
      options: () => options,
      resolveApiKey: () => {
        if (modelConfig.apiKey === null) throw new LlmError('No DeepSeek API key is configured for this tenant', 'MISSING_CREDENTIAL')
        return Promise.resolve(modelConfig.apiKey)
      },
      resolveUserId: () => getOrCreateAnonymousUserId(),
    }))
  }
  if (modelConfig.mode === 'openai') {
    if (modelConfig.baseUrl === null) throw new Error('OpenAI-compatible mode requires a base URL')
    await ctx.plugin(OpenAiCompatible, {
      baseUrl: modelConfig.baseUrl,
      model: modelConfig.defaultModel,
      apiKey: modelConfig.apiKey,
    })
  }
}
