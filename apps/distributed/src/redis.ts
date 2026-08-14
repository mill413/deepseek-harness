import { createClient, type RedisClientType } from 'redis'
import { config } from './config.ts'

export type RedisClient = RedisClientType

export async function connectRedis(): Promise<RedisClient> {
  const client = createClient({ url: config.redisUrl })
  client.on('error', (error: unknown) => { console.error('redis error', error) })
  await client.connect()
  return client
}

export async function ensureGroup(client: RedisClient): Promise<void> {
  try {
    await client.xGroupCreate(config.stream, config.group, '0', { MKSTREAM: true })
  } catch (error) {
    if (!String(error).includes('BUSYGROUP')) throw error
  }
}
