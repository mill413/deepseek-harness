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
import { splitInternalSessionId } from './identity.ts'
import { workspaceRootPath } from './workspace-path.ts'

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

async function sessionRow(client: PoolClient, id: SessionId, lock = false): Promise<SessionRow | undefined> {
  const { tenantId, sessionId } = splitInternalSessionId(id)
  const result = await client.query<SessionRow>(
    `SELECT tenant_id, id, header, workspace_id, revision FROM sessions WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [tenantId, sessionId],
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

  constructor(ctx: Context) {
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
      const row = await sessionRow(client, id)
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
      const row = await sessionRow(client, id)
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
      const row = await sessionRow(client, id)
      if (row?.header === null || row === undefined) return undefined
      const events = await this.readEvents(client, row.tenant_id, row.id, fromSeq)
      signal?.throwIfAborted()
      return { meta: structuredClone(row.header), events }
    } finally {
      client.release()
    }
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], _isMaterialized: boolean): Promise<void> {
    const { tenantId, sessionId } = splitInternalSessionId(meta.id)
    await tx(async (client) => {
      const row = await sessionRow(client, meta.id, true)
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
    const result = await pool.query<SessionRow>('SELECT tenant_id, id, header, workspace_id, revision FROM sessions WHERE header IS NOT NULL ORDER BY created_at')
    signal?.throwIfAborted()
    return result.rows.flatMap(row => row.header === null ? [] : [{
      ...structuredClone(row.header),
      ...row.workspace_id === null ? {} : { cwd: workspaceRootPath(row.tenant_id, row.workspace_id) },
    }])
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    const result = await pool.query<SessionRow>('SELECT tenant_id, id, header, workspace_id, revision FROM sessions WHERE header IS NOT NULL ORDER BY created_at')
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
