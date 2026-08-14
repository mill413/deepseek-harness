import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const outputRoot = resolve(process.argv[2] ?? join(repositoryRoot, 'apps/distributed/.web-root'))

const compositionPaths = [
  'packages/bundle/base/cordis.patch.yml',
  'packages/bundle/web-app/cordis.patch.yml',
]

// The upstream host auto-selects a native or browser directory picker. The
// distributed Web always uses the browser picker because the Host is remote.
const distributedClientRows = ['@deepseek-ai/dsh-client-ui-directory-picker-browse']

async function packageManifests(directory) {
  const manifests = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const child = join(directory, entry.name)
    try {
      const manifestPath = join(child, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifests.push({ directory: child, manifest })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      manifests.push(...await packageManifests(child))
    }
  }
  return manifests
}

const manifests = await packageManifests(join(repositoryRoot, 'packages'))
const manifestByName = new Map(manifests
  .filter(entry => typeof entry.manifest.name === 'string')
  .map(entry => [entry.manifest.name, entry]))
const composedNames = []
for (const relativePath of compositionPaths) {
  const composition = await readFile(join(repositoryRoot, relativePath), 'utf8')
  for (const match of composition.matchAll(/^\s+name:\s+'([^']+)'/gmu)) composedNames.push(match[1])
}
composedNames.push(...distributedClientRows)

const pluginEntries = []
const selectedNames = new Set()
for (const packageName of composedNames) {
  if (selectedNames.has(packageName)) continue
  const entry = manifestByName.get(packageName)
  if (entry?.manifest.dsh?.client === undefined) continue
  selectedNames.add(packageName)
  pluginEntries.push(entry)
}

const platformSource = await readFile(join(repositoryRoot, 'packages/client/web/src/platform.ts'), 'utf8')
const platformModules = new Set([...platformSource.matchAll(/'(@deepseek-ai\/[^']+|react(?:\/[^']+)?)'/gu)].map(match => match[1]))

await mkdir(outputRoot, { recursive: true })
await cp(join(repositoryRoot, 'apps/web/dist'), outputRoot, { recursive: true })

const entries = []
for (const { directory, manifest } of pluginEntries) {
  const declaration = manifest.dsh?.client
  if (typeof manifest.name !== 'string' || declaration?.platform !== 'web') {
    throw new Error(`${manifest.name ?? directory} is not a Web client plugin`)
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
  const missing = entry.inject.filter(dependency => !pluginIds.has(dependency) && !platformModules.has(dependency))
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
