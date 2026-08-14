import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const outputRoot = resolve(process.argv[2] ?? join(repositoryRoot, 'apps/distributed/.web-root'))

const pluginDirectories = [
  'packages/typert/registry',
  'packages/client/connection',
  'packages/api/gateway',
  'packages/api/remotes',
  'packages/client/ui-settings',
  'packages/client/runtime',
  'packages/client/ui-theme',
  'packages/client/locale',
  'packages/client/ui-layout',
  'packages/client/ui-sidebar',
  'packages/client/ui-conversation',
  'packages/client/ui-tool',
  'packages/client/ui-workflow-run',
  'packages/client/ui-workspace',
  'packages/client/ui-input-trigger',
  'packages/client/ui-commands',
  'packages/client/ui-model-selection',
]

await mkdir(outputRoot, { recursive: true })
await cp(join(repositoryRoot, 'apps/web/dist'), outputRoot, { recursive: true })

const entries = []
for (const relativeDirectory of pluginDirectories) {
  const directory = join(repositoryRoot, relativeDirectory)
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const declaration = manifest.dsh?.client
  if (typeof manifest.name !== 'string' || declaration?.platform !== 'web') {
    throw new Error(`${relativeDirectory} is not a Web client plugin`)
  }
  const source = join(directory, 'lib/client.js')
  const rev = createHash('sha256').update(await readFile(source)).digest('hex').slice(0, 12)
  const url = `/plugins/${manifest.name}/client.js?rev=${rev}`
  const target = join(outputRoot, 'plugins', manifest.name, 'client.js')
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target)
  entries.push({
    id: manifest.name,
    url,
    rev,
    inject: declaration.inject ?? [],
    ...(declaration.immediately === true ? { immediately: true } : {}),
  })
}

const pluginIds = new Set(entries.map(entry => entry.id))
for (const entry of entries) {
  const missing = entry.inject.filter(dependency => !pluginIds.has(dependency))
  if (missing.length > 0) {
    throw new Error(`${entry.id} has missing Web plugin dependencies: ${missing.join(', ')}`)
  }
}

const indexPath = join(outputRoot, 'index.html')
const index = await readFile(indexPath, 'utf8')
const shellMatch = /<script type="module" crossorigin src="([^"]+)"><\/script>/u.exec(index)
if (shellMatch === null) throw new Error('could not find the Web shell module in index.html')
const graphRev = createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 12)
const graph = JSON.stringify({ rev: graphRev, entries }).replaceAll('<', '\\u003c')
const script = `<script>window.__DSH_BOOT__ = ${graph}; window.__DSH_DISTRIBUTED_SHELL__ = ${JSON.stringify(shellMatch[1])}</script><link rel="stylesheet" href="/distributed-auth.css"><script type="module" src="/distributed-auth.js"></script>`
const shellDeferred = index.replace(shellMatch[0], '')
const head = index.indexOf('<head>')
const injected = head === -1
  ? `${script}${shellDeferred}`
  : `${shellDeferred.slice(0, head + 6)}${script}${shellDeferred.slice(head + 6)}`
await writeFile(indexPath, injected)
await cp(join(repositoryRoot, 'apps/distributed/web-shell/distributed-auth.js'), join(outputRoot, 'distributed-auth.js'))
await cp(join(repositoryRoot, 'apps/distributed/web-shell/distributed-auth.css'), join(outputRoot, 'distributed-auth.css'))

console.log(`assembled distributed Web UI with ${entries.length} plugins at ${outputRoot}`)
