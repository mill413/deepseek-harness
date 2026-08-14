/** PostgreSQL relay for Agent interactions that wait on the distributed Web client. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { QueryResultRow } from 'pg'
import { pool } from './db.ts'
import { splitInternalSessionId } from './identity.ts'

interface InteractionRow extends QueryResultRow {
  status: 'pending' | 'resolved' | 'cancelled'
  response: unknown
}

interface PendingApprovalPayload {
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

function delay(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, 100)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function publicSession(agentId: SessionId, tenantId: string): string {
  const identity = splitInternalSessionId(agentId)
  if (identity.tenantId !== tenantId) throw new Error('interactive agent belongs to another tenant')
  return identity.sessionId
}

async function waitForResponse(
  tenantId: string,
  rpcId: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  try {
    while (true) {
      signal?.throwIfAborted()
      const result = await pool.query<InteractionRow>(
        'SELECT status, response FROM pending_interactions WHERE tenant_id = $1 AND rpc_id = $2',
        [tenantId, rpcId],
      )
      const row = result.rows[0]
      if (row === undefined) throw new Error('pending interaction disappeared before it was answered')
      if (row.status === 'resolved') return row.response
      if (row.status === 'cancelled') throw new Error('pending interaction was cancelled')
      await delay(signal)
    }
  } catch (error) {
    if (signal?.aborted === true) {
      await pool.query(
        `UPDATE pending_interactions SET status = 'cancelled', updated_at = now()
         WHERE tenant_id = $1 AND rpc_id = $2 AND status = 'pending'`,
        [tenantId, rpcId],
      )
    }
    throw error
  }
}

async function askQuestion(
  tenantId: string,
  request: AskUserQuestionRequest,
): Promise<AskUserQuestionAnswer> {
  if (request.agent === undefined) {
    throw new UserQuestionError('distributed user interaction requires an agent-owned session', 'ASK_MISSING_AGENT')
  }
  const sessionId = publicSession(request.agent.id, tenantId)
  const rpcId = randomUUID()
  await pool.query(
    `INSERT INTO pending_interactions (tenant_id, rpc_id, session_id, kind, payload)
     VALUES ($1, $2, $3, 'question', $4::jsonb)`,
    [tenantId, rpcId, sessionId, JSON.stringify({ questions: request.questions })],
  )
  try {
    const response = await waitForResponse(tenantId, rpcId, request.signal)
    if (typeof response === 'object' && response !== null && 'cancelled' in response) {
      throw new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')
    }
    if (typeof response !== 'object' || response === null || !('answer' in response)) {
      throw new UserQuestionError('distributed question received an invalid answer', 'BAD_ANSWER')
    }
    return (response as { answer: AskUserQuestionAnswer }).answer
  } catch (error) {
    if (request.signal?.aborted === true) {
      throw new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED', { cause: error })
    }
    throw error
  }
}

function pendingApproval(events: readonly SessionEvent[], callId: string | undefined): PendingApprovalPayload | undefined {
  const decided = new Set<string>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'approval/decided') {
      decided.add(event.data.id)
      continue
    }
    if (event.type !== 'approval/asked' || decided.has(event.data.id)) continue
    if ((event.data.callId ?? null) !== (callId ?? null)) continue
    return {
      approvalId: event.data.id,
      toolName: event.data.toolName,
      ...(event.data.callId === undefined ? {} : { callId: event.data.callId }),
      ...(event.data.reason === undefined ? {} : { reason: event.data.reason }),
    }
  }
  return undefined
}

/** Attach durable question and approval answerers to one tenant Workspace runtime. */
export function registerDistributedInteractions(ctx: Context, tenantId: string): void {
  ctx.userQuestions.registerProvider({ ask: request => askQuestion(tenantId, request) })
  ctx.on('approval/request', async (request, next) => {
    const payload = pendingApproval(request.agent.session.events, request.callId)
    if (payload === undefined) return next()
    const sessionId = publicSession(request.agent.id, tenantId)
    const rpcId = randomUUID()
    await pool.query(
      `INSERT INTO pending_interactions (tenant_id, rpc_id, session_id, kind, payload)
       VALUES ($1, $2, $3, 'approval', $4::jsonb)`,
      [tenantId, rpcId, sessionId, JSON.stringify(payload)],
    )
    try {
      const response = await waitForResponse(tenantId, rpcId, request.signal)
      if (typeof response !== 'object' || response === null || !('outcome' in response)) return 'unavailable'
      return (response as { outcome: ApprovalOutcome }).outcome
    } catch {
      return request.signal?.aborted === true ? 'cancelled' : 'unavailable'
    }
  })
}
