import type { Context } from '@deepseek-ai/cordis'
import { SessionPreparation, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
  type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'
import type { PoolClient } from 'pg'
import { pool, tx } from './db.ts'
import { assertUuid, splitInternalSessionId } from './identity.ts'
import { workspaceRootPath } from './workspace-path.ts'

export interface Config {
  tenantId: string
  workspaceId: string
}

interface SessionRow {
  tenant_id: string
  id: string
  header: SessionHeader | null
  workspace_id: string | null
  revision: string
}

function revision(row: SessionRow): SessionPersistenceRevision {
  return SessionPersistenceRevision(`postgres:${row.tenant_id}:${row.id}:${row.revision}`)
}

function databaseIdentity(id: SessionId, config: Config): { tenantId: string; sessionId: string } {
  if (String(id).includes('/')) {
    const identity = splitInternalSessionId(id)
    if (identity.tenantId !== config.tenantId) throw new Error(`session belongs to another tenant: ${id}`)
    return identity
  }
  return { tenantId: config.tenantId, sessionId: assertUuid(String(id), 'sessionId') }
}

async function sessionRow(client: PoolClient, id: SessionId, config: Config, lock = false): Promise<SessionRow | undefined> {
  const { tenantId, sessionId } = databaseIdentity(id, config)
  const result = await client.query<SessionRow>(
    `SELECT tenant_id, id, header, workspace_id, revision FROM sessions
     WHERE tenant_id = $1 AND id = $2 AND workspace_id = $3${lock ? ' FOR UPDATE' : ''}`,
    [tenantId, sessionId, config.workspaceId],
  )
  const row = result.rows[0]
  if (row?.header === null || row === undefined || row.workspace_id === null) return row
  return {
    ...row,
    header: { ...row.header, cwd: workspaceRootPath(row.tenant_id, row.workspace_id) },
  }
}

/** PostgreSQL-backed Harness event log; API session rows become materialized on the first event append. */
export class PostgresSessionPersistence extends SessionPersistence implements PersistenceBackend<never> {
  override readonly supportsRawArtifacts = false
  override readonly name = 'session-persistence-postgres'
  static inject = ['sessions']

  private readonly coordinator: PersistenceCoordinator<never>

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    this.coordinator = new PersistenceCoordinator(ctx, this, {
      preparedSessionCacheSize: DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })
  }

  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    signal?.throwIfAborted()
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const row = await sessionRow(client, id, this.config)
      if (row?.header === null || row === undefined) {
        await client.query('COMMIT')
        return undefined
      }
      const events = await this.readEvents(client, row.tenant_id, row.id, 0)
      await client.query('COMMIT')
      signal?.throwIfAborted()
      return { meta: structuredClone(row.header), events, revision: revision(row) }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted()
    const client = await pool.connect()
    try {
      const row = await sessionRow(client, id, this.config)
      signal?.throwIfAborted()
      return row?.header === null || row === undefined ? undefined : revision(row)
    } finally {
      client.release()
    }
  }

  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted()
    const client = await pool.connect()
    try {
      const row = await sessionRow(client, id, this.config)
      if (row?.header === null || row === undefined) return undefined
      const events = await this.readEvents(client, row.tenant_id, row.id, fromSeq)
      signal?.throwIfAborted()
      return { meta: structuredClone(row.header), events }
    } finally {
      client.release()
    }
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], _isMaterialized: boolean): Promise<void> {
    const { tenantId, sessionId } = databaseIdentity(meta.id, this.config)
    await tx(async (client) => {
      let row = await sessionRow(client, meta.id, this.config, true)
      if (row === undefined && meta.origin === 'subagent' && meta.parentSession !== undefined) {
        const parent = databaseIdentity(meta.parentSession, this.config)
        const inserted = await client.query(`
          INSERT INTO sessions
            (tenant_id, id, owner_user_id, workspace_id, workspace_order, provider, model,
             agent_preset, permission_preset, parent_session_id, header)
          SELECT tenant_id, $3, owner_user_id, workspace_id,
            -floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
            provider, model, agent_preset, permission_preset, $4, $5::jsonb
          FROM sessions
          WHERE tenant_id = $1 AND id = $2 AND workspace_id = $6
          ON CONFLICT (tenant_id, id) DO NOTHING
        `, [tenantId, parent.sessionId, sessionId, parent.sessionId, JSON.stringify(meta), this.config.workspaceId])
        if (inserted.rowCount !== 1) throw new Error(`subagent parent session does not exist: ${meta.parentSession}`)
        row = await sessionRow(client, meta.id, this.config, true)
      }
      if (row === undefined) throw new Error(`session does not exist: ${meta.id}`)
      if (row.header === null) {
        await client.query('UPDATE sessions SET header = $3::jsonb WHERE tenant_id = $1 AND id = $2', [tenantId, sessionId, JSON.stringify(meta)])
      }
      for (const event of events) {
        await client.query(
          'INSERT INTO session_events (tenant_id, session_id, seq, event) VALUES ($1, $2, $3, $4::jsonb)',
          [tenantId, sessionId, event.seq, JSON.stringify(event)],
        )
      }
      await client.query(
        'UPDATE sessions SET revision = revision + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2',
        [tenantId, sessionId],
      )
    })
  }

  async commitRepair(meta: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    if (closers.length === 0) return
    await this.appendBatch(meta, closers, true)
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    const result = await pool.query<SessionRow>(
      'SELECT tenant_id, id, header, workspace_id, revision FROM sessions WHERE tenant_id = $1 AND workspace_id = $2 AND header IS NOT NULL ORDER BY created_at',
      [this.config.tenantId, this.config.workspaceId],
    )
    signal?.throwIfAborted()
    return result.rows.flatMap(row => row.header === null ? [] : [{
      ...structuredClone(row.header),
      ...row.workspace_id === null ? {} : { cwd: workspaceRootPath(row.tenant_id, row.workspace_id) },
    }])
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    const result = await pool.query<SessionRow>(
      'SELECT tenant_id, id, header, workspace_id, revision FROM sessions WHERE tenant_id = $1 AND workspace_id = $2 AND header IS NOT NULL ORDER BY created_at',
      [this.config.tenantId, this.config.workspaceId],
    )
    signal?.throwIfAborted()
    return result.rows.flatMap(row => row.header === null ? [] : [{
      header: {
        ...structuredClone(row.header),
        ...row.workspace_id === null ? {} : { cwd: workspaceRootPath(row.tenant_id, row.workspace_id) },
      },
      revision: revision(row),
    }])
  }

  private async readEvents(client: PoolClient, tenantId: string, sessionId: string, fromSeq: number): Promise<SessionEvent[]> {
    const result = await client.query<{ event: SessionEvent }>(
      'SELECT event FROM session_events WHERE tenant_id = $1 AND session_id = $2 AND seq >= $3 ORDER BY seq',
      [tenantId, sessionId, fromSeq],
    )
    return result.rows.map(row => structuredClone(row.event))
  }
}

export default PostgresSessionPersistence
