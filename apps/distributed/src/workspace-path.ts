import { resolve } from 'node:path'
import { config } from './config.ts'
import { assertUuid } from './identity.ts'

/** Return the deterministic persistent directory owned by one tenant workspace. */
export function workspaceRootPath(tenantId: string, workspaceId: string): string {
  const tenant = assertUuid(tenantId, 'tenantId')
  const workspace = assertUuid(workspaceId, 'workspaceId')
  return resolve(config.workspaceRoot, tenant, workspace)
}
