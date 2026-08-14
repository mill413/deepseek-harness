import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { config } from './config.ts'
import { one, pool, tx } from './db.ts'
import { assertUuid, HttpError } from './identity.ts'
import { hashPassword, verifyPassword } from './secrets.ts'

export interface Identity {
  tenantId: string
  userId: string
  tenantName?: string
  tenantSlug?: string
  username?: string
  role: 'admin' | 'member' | 'api'
}

interface BrowserIdentityRow {
  tenant_id: string
  user_id: string
  tenant_name: string
  tenant_slug: string
  username: string
  role: 'admin' | 'member'
}

interface LoginRow extends BrowserIdentityRow {
  password_salt: string
  password_hash: string
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(part.slice(separator + 1).trim())
  }
  return undefined
}

export function setSessionCookie(response: ServerResponse, token: string): void {
  response.setHeader('set-cookie', `${config.authCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.authSessionTtlSeconds}`)
}

export function clearSessionCookie(response: ServerResponse): void {
  response.setHeader('set-cookie', `${config.authCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
}

export async function createBrowserSession(identity: Pick<Identity, 'tenantId' | 'userId'>): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await pool.query(`
    INSERT INTO browser_sessions (token_hash, tenant_id, user_id, expires_at)
    VALUES ($1, $2, $3, now() + ($4 * interval '1 second'))
  `, [tokenHash(token), identity.tenantId, identity.userId, config.authSessionTtlSeconds])
  return token
}

export async function authenticate(request: IncomingMessage): Promise<Identity> {
  const tenant = request.headers['x-tenant-id']
  const user = request.headers['x-user-id']
  if (typeof tenant === 'string' && typeof user === 'string' && user.trim() !== '') {
    return { tenantId: assertUuid(tenant, 'x-tenant-id'), userId: user.trim(), role: 'api' }
  }

  const token = cookieValue(request, config.authCookieName)
  if (token === undefined || token === '') throw new HttpError(401, 'authentication required')
  const row = await one<BrowserIdentityRow>(`
    SELECT s.tenant_id, s.user_id, t.name AS tenant_name, t.slug AS tenant_slug, u.username, u.role
    FROM browser_sessions s
    JOIN tenants t ON t.id = s.tenant_id
    JOIN tenant_users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > now() AND t.status = 'active'
  `, [tokenHash(token)])
  if (row === undefined) throw new HttpError(401, 'session expired or invalid')
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    tenantName: row.tenant_name,
    tenantSlug: row.tenant_slug,
    username: row.username,
    role: row.role,
  }
}

export async function registerTenant(input: {
  tenantName: string
  tenantSlug: string
  username: string
  password: string
}): Promise<Identity> {
  const tenantId = randomUUID()
  const userId = randomUUID()
  const password = await hashPassword(input.password)
  try {
    await tx(async (client) => {
      await client.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [tenantId, input.tenantName, input.tenantSlug])
      await client.query(`
        INSERT INTO tenant_workspaces (tenant_id, id, path, title, sort_order, is_default)
        VALUES ($1, $2, '/workspace', 'Default', 0, true)
      `, [tenantId, randomUUID()])
      await client.query(`
        INSERT INTO tenant_users
          (tenant_id, id, username, username_normalized, password_salt, password_hash, role)
        VALUES ($1, $2, $3, $4, $5, $6, 'admin')
      `, [tenantId, userId, input.username, input.username.toLocaleLowerCase('en-US'), password.salt, password.hash])
    })
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') {
      throw new HttpError(409, 'tenant slug already exists')
    }
    throw error
  }
  return {
    tenantId,
    userId,
    tenantName: input.tenantName,
    tenantSlug: input.tenantSlug,
    username: input.username,
    role: 'admin',
  }
}

export async function login(input: { tenantSlug: string; username: string; password: string }): Promise<Identity> {
  const row = await one<LoginRow>(`
    SELECT t.id AS tenant_id, u.id AS user_id, t.name AS tenant_name, t.slug AS tenant_slug,
      u.username, u.role, u.password_salt, u.password_hash
    FROM tenants t JOIN tenant_users u ON u.tenant_id = t.id
    WHERE lower(t.slug) = lower($1) AND u.username_normalized = $2 AND t.status = 'active'
  `, [input.tenantSlug, input.username.toLocaleLowerCase('en-US')])
  if (row === undefined || !(await verifyPassword(input.password, row.password_salt, row.password_hash))) {
    throw new HttpError(401, 'tenant, username, or password is incorrect')
  }
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    tenantName: row.tenant_name,
    tenantSlug: row.tenant_slug,
    username: row.username,
    role: row.role,
  }
}

export async function logout(request: IncomingMessage): Promise<void> {
  const token = cookieValue(request, config.authCookieName)
  if (token !== undefined) await pool.query('DELETE FROM browser_sessions WHERE token_hash = $1', [tokenHash(token)])
}

export function identityView(identity: Identity): Record<string, unknown> {
  return {
    tenant: { id: identity.tenantId, name: identity.tenantName, slug: identity.tenantSlug },
    user: { id: identity.userId, username: identity.username, role: identity.role },
  }
}
