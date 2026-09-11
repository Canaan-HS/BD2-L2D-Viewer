import { existsSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'

const CONFIG_FILE = 'external-models.yaml'
const LIST_ROUTE = '/list'
const FILE_ROUTE_PREFIX = '/file/'
const MAX_SCAN_DEPTH = 32
const ATLAS_SUFFIX = /\.atlas$/i
const SKELETON_JSON_SUFFIX = /\.json$/i
const SKELETON_BINARY_SUFFIX = /\.skel$/i
const IMAGE_FILE_PATTERN = /\.(?:png|webp|jpe?g)$/i
const ATLAS_PAGE_PATTERN = /[^\s"']+?\.(?:png|webp|jpe?g)\b/gi
const ATTACHMENT_DIR_NAMES = new Set(['textures'])
const BACK_FILE_PATTERN = /back/i

interface ExternalModelEntry {
  id: string
  name: string
  atlas: string
  skel: string | null
  json: string | null
  images: string[]
  backgrounds?: string[]
}

export default function externalModelsPlugin(): Plugin {
  return {
    name: 'bd2-external-models',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      const projectRoot = server.config.root ?? process.cwd()
      server.middlewares.use('/external-models', (req, res) => {
        handleRequest(projectRoot, req, res).catch(error => {
          if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          }
          res.end(`[external-models] ${error instanceof Error ? error.message : String(error)}`)
        })
      })
    },
  }
}

async function handleRequest(projectRoot: string, req: IncomingMessage, res: ServerResponse) {
  let pathname: string
  try {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost')
    pathname = decodeURIComponent(requestUrl.pathname)
  } catch {
    res.statusCode = 400
    res.end('Bad request')
    return
  }

  if (pathname === LIST_ROUTE) {
    const roots = await readConfiguredRoots(projectRoot)
    const entries = await scanRoots(roots)
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(entries))
    return
  }

  const fileMatch = new RegExp(`^${FILE_ROUTE_PREFIX}([^/]+)/(.+)$`, 's').exec(pathname)
  if (fileMatch?.[1] && fileMatch[2]) {
    await serveModelFile(projectRoot, fileMatch[1], fileMatch[2], res)
    return
  }

  res.statusCode = 404
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end('Not found')
}

async function readConfiguredRoots(projectRoot: string): Promise<string[]> {
  const configPath = path.join(projectRoot, CONFIG_FILE)
  if (!existsSync(configPath)) return []

  let parsed: unknown
  try {
    parsed = parseYaml(await readFile(configPath, 'utf8'))
  } catch (error) {
    console.warn(`[external-models] Failed to parse ${CONFIG_FILE}: ${error instanceof Error ? error.message : error}`)
    return []
  }

  const rawPaths = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { paths?: unknown }).paths)
      ? (parsed as { paths: unknown[] }).paths
      : []

  const roots = rawPaths
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => path.resolve(value.trim()))

  return [...new Set(roots)]
}

async function scanRoots(roots: string[]): Promise<ExternalModelEntry[]> {
  const entries: ExternalModelEntry[] = []
  for (const root of roots) {
    if (!(await pathExists(root))) {
      console.warn(`[external-models] Configured path not found: ${root}`)
      continue
    }
    await collectEntries(root, 0, entries)
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function collectEntries(currentDir: string, depth: number, out: ExternalModelEntry[]): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return

  let dirents
  try {
    dirents = await readdir(currentDir, { withFileTypes: true })
  } catch {
    return
  }

  const files = dirents.filter(dirent => dirent.isFile()).map(dirent => dirent.name)
  const atlases = files.filter(name => ATLAS_SUFFIX.test(name))
  const skeletons = files.filter(name => SKELETON_BINARY_SUFFIX.test(name) || SKELETON_JSON_SUFFIX.test(name))

  if (atlases.length > 0 && skeletons.length > 0) {
    const entries = await buildModelEntries(currentDir, atlases, skeletons, files)
    const excludedPages = new Set(entries.flatMap(entry => entry.images.map(name => name.toLowerCase())))
    const backgrounds = await collectBackgrounds(currentDir, dirents, excludedPages)
    for (const entry of entries) {
      entry.backgrounds = backgrounds
    }
    out.push(...entries)
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
    await collectEntries(path.join(currentDir, dirent.name), depth + 1, out)
  }
}

async function buildModelEntries(
  dir: string,
  atlases: string[],
  skeletons: string[],
  allFiles: string[],
): Promise<ExternalModelEntry[]> {
  const folderName = path.basename(dir)
  const usedSkeletons = new Set<string>()
  const entries: ExternalModelEntry[] = []

  for (const [index, atlas] of atlases.entries()) {
    const stem = atlas.replace(ATLAS_SUFFIX, '').toLowerCase()
    const unused = skeletons.filter(name => !usedSkeletons.has(name.toLowerCase()))
    const skeleton =
      unused.find(name => equalsIgnoreCase(name, `${stem}.skel`)) ??
      unused.find(name => equalsIgnoreCase(name, `${stem}.json`)) ??
      unused.find(name => SKELETON_BINARY_SUFFIX.test(name)) ??
      unused.find(name => SKELETON_JSON_SUFFIX.test(name))

    if (!skeleton) break
    usedSkeletons.add(skeleton.toLowerCase())

    entries.push({
      id: Buffer.from(dir, 'utf8').toString('base64url'),
      name: index === 0 ? folderName : `${folderName}_${index + 1}`,
      atlas,
      skel: SKELETON_BINARY_SUFFIX.test(skeleton) ? skeleton : null,
      json: SKELETON_JSON_SUFFIX.test(skeleton) ? skeleton : null,
      images: await extractPageNames(path.join(dir, atlas), allFiles),
    })
  }

  return entries
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

async function collectBackgrounds(dir: string, dirents: Dirent[], excludedPages: Set<string>): Promise<string[]> {
  const backgrounds: string[] = []
  const seen = new Set<string>()

  const addBackground = (relativePath: string) => {
    const key = relativePath.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    backgrounds.push(relativePath)
  }

  for (const dirent of dirents) {
    if (!dirent.isFile() || !IMAGE_FILE_PATTERN.test(dirent.name)) continue
    if (excludedPages.has(dirent.name.toLowerCase())) continue
    if (BACK_FILE_PATTERN.test(dirent.name)) addBackground(dirent.name)
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    if (!ATTACHMENT_DIR_NAMES.has(dirent.name.toLowerCase())) continue

    let nestedDirents: Dirent[]
    try {
      nestedDirents = await readdir(path.join(dir, dirent.name), { withFileTypes: true })
    } catch {
      continue
    }

    for (const nestedDirent of nestedDirents) {
      if (!nestedDirent.isFile() || !IMAGE_FILE_PATTERN.test(nestedDirent.name)) continue
      if (excludedPages.has(nestedDirent.name.toLowerCase())) continue
      addBackground(`${dirent.name}/${nestedDirent.name}`)
    }
  }

  return backgrounds.sort((a, b) => a.localeCompare(b))
}

async function extractPageNames(atlasFilePath: string, allFiles: string[]): Promise<string[]> {
  let atlasText = ''
  try {
    atlasText = await readFile(atlasFilePath, 'utf8')
  } catch {
    atlasText = ''
  }

  const lowerFileSet = new Set(allFiles.map(name => name.toLowerCase()))
  const pages: string[] = []
  const seen = new Set<string>()

  for (const match of atlasText.matchAll(ATLAS_PAGE_PATTERN)) {
    const pageName = match[0]
    const key = pageName.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (lowerFileSet.has(key)) pages.push(pageName)
  }

  if (pages.length === 0) {
    for (const name of allFiles) {
      if (!IMAGE_FILE_PATTERN.test(name)) continue
      const key = name.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        pages.push(name)
      }
    }
  }

  return pages
}

async function serveModelFile(projectRoot: string, modelId: string, fileName: string, res: ServerResponse) {
  const roots = await readConfiguredRoots(projectRoot)
  const modelDir = Buffer.from(modelId, 'base64url').toString('utf8')
  const isAllowedModelDir =
    modelDir.length > 0 && path.isAbsolute(modelDir) && roots.some(root => isInsideOrEqual(modelDir, root))
  const filePath = isAllowedModelDir ? path.resolve(modelDir, fileName) : null

  if (!filePath || !isInsideOrEqual(filePath, modelDir)) {
    res.statusCode = 403
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('Forbidden')
    return
  }

  let data: Buffer
  try {
    data = await readFile(filePath)
  } catch {
    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('Not found')
    return
  }

  res.statusCode = 200
  res.setHeader('Content-Type', getContentType(fileName))
  res.end(data)
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function getContentType(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.atlas':
      return 'text/plain; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}
