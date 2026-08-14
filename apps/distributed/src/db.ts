import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import { config } from './config.ts'

export const pool = new Pool({ connectionString: config.postgresUrl, max: 10 })

export async function migrate(): Promise<void> {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url))
  const migrations = (await readdir(directory)).filter(file => /^\d+_.+\.sql$/u.test(file)).sort()
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(1807548791)')
    for (const migration of migrations) {
      await client.query(await readFile(new URL(migration, new URL('../migrations/', import.meta.url)), 'utf8'))
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(1807548791)').catch(() => undefined)
    client.release()
  }
}

export async function tx<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function one<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T | undefined> {
  const result = await pool.query<T>(text, values)
  return result.rows[0]
}

export function json(value: unknown): string {
  return JSON.stringify(value)
}
