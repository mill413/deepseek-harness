function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function llmMode(value: string | undefined): 'mock' | 'deepseek' | 'openai' {
  const mode = value ?? 'mock'
  if (mode !== 'mock' && mode !== 'deepseek' && mode !== 'openai') {
    throw new Error('DISTRIBUTED_LLM_MODE must be mock, deepseek, or openai')
  }
  return mode
}

export const config = {
  postgresUrl: process.env['DATABASE_URL'] ?? 'postgres://dsh:dsh@127.0.0.1:5432/dsh',
  redisUrl: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
  apiPort: integer('API_PORT', 3100),
  apiInstanceId: process.env['API_INSTANCE_ID'] ?? `api-${process.pid}`,
  workerId: process.env['WORKER_ID'] ?? `worker-${process.pid}`,
  workspacePort: integer('WORKSPACE_PORT', 3200),
  workspaceRoot: process.env['WORKSPACE_ROOT'] ?? '/workspaces',
  workspaceServiceUrl: process.env['WORKSPACE_SERVICE_URL'] ?? 'http://127.0.0.1:3200',
  workspaceServiceToken: process.env['WORKSPACE_SERVICE_TOKEN'] ?? 'replace-this-development-workspace-token',
  stream: process.env['COMMAND_STREAM'] ?? 'dsh:agent:commands',
  group: process.env['COMMAND_GROUP'] ?? 'dsh-workers',
  outboxIntervalMs: integer('OUTBOX_INTERVAL_MS', 100),
  leaseSeconds: integer('SESSION_LEASE_SECONDS', 60),
  heartbeatSeconds: integer('WORKER_HEARTBEAT_SECONDS', 5),
  mockDelayMs: integer('MOCK_LLM_DELAY_MS', 200),
  llmMode: llmMode(process.env['DISTRIBUTED_LLM_MODE']),
  defaultProvider: process.env['DEFAULT_PROVIDER'] ?? 'distributed-mock',
  defaultModel: process.env['DEFAULT_MODEL'] ?? 'mock-agent',
  deepSeekApiKey: process.env['DEEPSEEK_API_KEY'] ?? '',
  deepSeekBaseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
  openAiApiKey: process.env['OPENAI_API_KEY'] ?? '',
  openAiBaseUrl: process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
  authCookieName: process.env['AUTH_COOKIE_NAME'] ?? 'dsh_session',
  authSessionTtlSeconds: integer('AUTH_SESSION_TTL_SECONDS', 60 * 60 * 24 * 7),
  modelConfigEncryptionKey: process.env['MODEL_CONFIG_ENCRYPTION_KEY'] ?? 'replace-this-development-encryption-key',
} as const
