import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { config } from './config.ts'

const scrypt = promisify(scryptCallback)
const encryptionKey = createHash('sha256').update(config.modelConfigEncryptionKey, 'utf8').digest()

export async function hashPassword(password: string, salt = randomBytes(16).toString('base64url')): Promise<{ salt: string; hash: string }> {
  const derived = await scrypt(password, salt, 64) as Buffer
  return { salt, hash: derived.toString('base64url') }
}

export async function verifyPassword(password: string, salt: string, expected: string): Promise<boolean> {
  const derived = await scrypt(password, salt, 64) as Buffer
  const actual = Buffer.from(expected, 'base64url')
  return actual.length === derived.length && timingSafeEqual(actual, derived)
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.')
}

export function decryptSecret(value: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split('.')
  if (ivValue === undefined || tagValue === undefined || encryptedValue === undefined) throw new Error('invalid encrypted secret')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8')
}
