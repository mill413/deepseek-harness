import { SessionId } from '@deepseek-ai/dsh-session'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function assertUuid(value: string, label: string): string {
  if (!UUID.test(value)) throw new HttpError(400, `${label} must be a UUID`)
  return value.toLowerCase()
}

export function internalSessionId(tenantId: string, sessionId: string): SessionId {
  return SessionId(`${tenantId}/${sessionId}`)
}

export function splitInternalSessionId(id: SessionId): { tenantId: string; sessionId: string } {
  const [tenantId, sessionId, extra] = String(id).split('/')
  if (tenantId === undefined || sessionId === undefined || extra !== undefined || !UUID.test(tenantId) || !UUID.test(sessionId)) {
    throw new Error(`invalid distributed session id: ${id}`)
  }
  return { tenantId, sessionId }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}
